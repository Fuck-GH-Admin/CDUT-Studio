/**
 * TipTap docJson <-> Canvas IElement[] 双向适配
 *
 * 硬性约束：本文件只允许 `import type` 引用 Canvas 引擎类型；
 * 运行时枚举全部来自 cslab-canvas-enums.ts，保证 Bun 单测无 DOM 也能加载。
 */

import type { CsLabCapsule, CsLabCanvasData, CsLabManuscriptComment } from '@profer/shared'
import type { IElement } from '@hufe921/canvas-editor'
import {
  CsCanvasControlComponent,
  CsCanvasElementType,
  CsCanvasListStyle,
  CsCanvasListType,
  HEADING_TO_TITLE_LEVEL,
  TITLE_LEVEL_TO_HEADING,
} from './cslab-canvas-enums'
import {
  buildCanvasCapsuleControl,
  capsuleDisplayText,
  capsuleExtensionOf,
  isCapsuleValueElement,
  type CsLabCapsuleExtension,
} from './cslab-canvas-capsule'
import type { CsLabCapsuleAttrs } from './cslab-canvas-types'
import { CSLAB_PERSONA_META } from '../cslab-review-personas'

const COMMENT_AUTHOR = 'CDUT Science'

type TipTapMark = {
  type?: string
  attrs?: Record<string, unknown>
}

type TipTapNode = {
  type?: string
  attrs?: Record<string, unknown>
  content?: TipTapNode[]
  text?: string
  marks?: TipTapMark[]
}

interface LegacyCommentDraft {
  id: string
  personaTitle: string
  kind: 'comment' | 'insertion' | 'deletion'
  commentText: string
  text: string
  createdAt: number
}

export interface LegacyCanvasConversion {
  canvasData: CsLabCanvasData
  comments: CsLabManuscriptComment[]
}

function readMarks(node: TipTapNode): {
  style: Partial<IElement>
  groupIds: string[]
  commentIds: string[]
} {
  const style: Partial<IElement> = {}
  const groupIds: string[] = []
  const commentIds: string[] = []
  for (const mark of node.marks ?? []) {
    const type = mark.type ?? ''
    if (type === 'bold') style.bold = true
    else if (type === 'italic') style.italic = true
    else if (type === 'underline') style.underline = true
    else if (type === 'strike') style.strikeout = true
    else if (type === 'code') style.font = 'Consolas'
    else if (type === 'comment' || type === 'insertion' || type === 'deletion') {
      const attrs = mark.attrs ?? {}
      const suggestionId = String(attrs.suggestionId ?? '')
      if (!suggestionId) continue
      const groupId = `legacy-${suggestionId}`
      if (!groupIds.includes(groupId)) groupIds.push(groupId)
      if (!commentIds.includes(groupId)) commentIds.push(groupId)
    }
  }
  return { style, groupIds, commentIds }
}

function pushChars(
  target: IElement[],
  text: string,
  style: Partial<IElement>,
  groupIds: string[],
): void {
  if (!text) return
  for (const char of Array.from(text)) {
    if (char === '\n') {
      target.push({ value: '\n' })
      continue
    }
    target.push({
      value: char,
      ...style,
      ...(groupIds.length > 0 ? { groupIds: [...groupIds] } : {}),
    })
  }
}

function blockToElements(
  node: TipTapNode,
  target: IElement[],
  drafts: Map<string, LegacyCommentDraft>,
): void {
  const type = String(node.type ?? '')
  const content = Array.isArray(node.content) ? node.content : []

  const inlineToElements = (inlines: TipTapNode[]): IElement[] => {
    const result: IElement[] = []
    for (const inline of inlines) {
      const inlineType = String(inline.type ?? '')
      if (inlineType === 'text') {
        const { style, groupIds, commentIds } = readMarks(inline)
        const text = String(inline.text ?? '')
        for (const suggestionId of inline.marks ?? []) {
          const markType = suggestionId.type ?? ''
          if (markType !== 'comment' && markType !== 'insertion' && markType !== 'deletion') continue
          const attrs = suggestionId.attrs ?? {}
          const rawId = String(attrs.suggestionId ?? '')
          if (!rawId) continue
          const id = `legacy-${rawId}`
          const personaType = String(attrs.personaType ?? 'human')
          const personaTitle =
            CSLAB_PERSONA_META[personaType as keyof typeof CSLAB_PERSONA_META]?.title ??
            '人工审阅'
          const createdAtRaw = Number(attrs.createdAt)
          const createdAt = Number.isFinite(createdAtRaw) ? createdAtRaw : Date.now()
          const existing = drafts.get(id)
          if (!existing) {
            drafts.set(id, {
              id,
              personaTitle,
              kind:
                markType === 'comment'
                  ? 'comment'
                  : markType === 'insertion'
                    ? 'insertion'
                    : 'deletion',
              commentText: String(attrs.commentText ?? ''),
              text,
              createdAt,
            })
          } else {
            existing.text += text
          }
        }
        pushChars(result, text, style, groupIds)
        void commentIds
        continue
      }
      if (inlineType === 'hardBreak') {
        result.push({ value: '\n' })
        continue
      }
      if (inlineType === 'scienceCapsule') {
        const attrs = (inline.attrs ?? {}) as Record<string, unknown>
        const capsuleAttrs: CsLabCapsuleAttrs = {
          capsuleId: String(attrs.capsuleId ?? ''),
          label: String(attrs.label ?? ''),
          value: String(attrs.value ?? ''),
          unit: String(attrs.unit ?? ''),
          tableUri: String(attrs.tableUri ?? ''),
          column: String(attrs.column ?? ''),
          rowIndex: Number(attrs.rowIndex ?? 0),
          revisionAtBind: Number(attrs.revisionAtBind ?? 0),
          status:
            (attrs.status as CsLabCapsuleAttrs['status'] | undefined) ??
            (attrs.tableUri ? 'fresh' : 'orphan'),
        }
        if (capsuleAttrs.capsuleId) {
          result.push(
            buildCanvasCapsuleControl(
              capsuleAttrs,
              capsuleAttrs.status === 'stale',
              capsuleAttrs.status === 'orphan',
            ),
          )
        }
        continue
      }
      if (inlineType === 'image') {
        pushChars(result, '[图片]', {}, [])
        continue
      }
      if (Array.isArray(inline.content)) {
        result.push(...inlineToElements(inline.content))
      }
    }
    return result
  }

  switch (type) {
    case 'heading': {
      const level = Number((node.attrs ?? {}).level ?? 1)
      target.push({
        type: CsCanvasElementType.TITLE as unknown as NonNullable<IElement['type']>,
        level: HEADING_TO_TITLE_LEVEL[Math.max(1, Math.min(6, level))],
        value: '',
        valueList: inlineToElements(content),
      } as IElement)
      target.push({ value: '\n' })
      return
    }
    case 'paragraph':
      target.push(...inlineToElements(content))
      target.push({ value: '\n' })
      return
    case 'bulletList':
    case 'orderedList': {
      const listType =
        type === 'bulletList' ? CsCanvasListType.UL : CsCanvasListType.OL
      const listStyle =
        type === 'bulletList' ? CsCanvasListStyle.DISC : CsCanvasListStyle.DECIMAL
      for (const item of content) {
        const itemContent = Array.isArray(item.content) ? item.content : []
        const paragraph = itemContent.find((child) => child.type === 'paragraph')
        const valueList = paragraph
          ? inlineToElements(paragraph.content ?? [])
          : inlineToElements(itemContent)
        target.push({
          type: CsCanvasElementType.LIST as unknown as NonNullable<IElement['type']>,
          listType,
          listStyle,
          value: '',
          valueList,
        } as IElement)
        target.push({ value: '\n' })
      }
      return
    }
    case 'blockquote':
      pushChars(target, '｜ ', {}, [])
      for (const child of content) blockToElements(child, target, drafts)
      return
    case 'horizontalRule':
      pushChars(target, '———', {}, [])
      target.push({ value: '\n' })
      return
    case 'codeBlock': {
      const text = content.map((child) => String(child.text ?? '')).join('')
      for (const char of Array.from(text)) {
        target.push(char === '\n' ? { value: '\n' } : { value: char, font: 'Consolas' })
      }
      target.push({ value: '\n' })
      return
    }
    case 'table': {
      for (const row of content) {
        const cells = Array.isArray(row.content) ? row.content : []
        const text = cells
          .map((cell) =>
            (cell.content ?? [])
              .map((paragraph) =>
                (paragraph.content ?? [])
                  .map((inline) => String(inline.text ?? inline.attrs?.value ?? ''))
                  .join(''),
              )
              .join(' '),
          )
          .join('\t')
        pushChars(target, text, {}, [])
        target.push({ value: '\n' })
      }
      return
    }
    default:
      if (content.length > 0) {
        for (const child of content) {
          if (child.type === 'text' || child.type === 'hardBreak' || child.type === 'scienceCapsule') {
            target.push(...inlineToElements([child]))
          } else {
            blockToElements(child, target, drafts)
          }
        }
      }
      return
  }
}

function finalizeComments(drafts: Map<string, LegacyCommentDraft>): CsLabManuscriptComment[] {
  const result: CsLabManuscriptComment[] = []
  for (const draft of drafts.values()) {
    let content = ''
    if (draft.kind === 'comment') {
      content = draft.commentText ? `【${draft.personaTitle}】${draft.commentText}` : ''
    } else if (draft.kind === 'insertion') {
      content = draft.text ? `【${draft.personaTitle}】建议插入：${draft.text}` : ''
    } else {
      content = draft.text ? `【${draft.personaTitle}】建议删除：「${draft.text}」` : ''
    }
    if (!content) continue
    result.push({
      id: draft.id,
      content,
      createdAt: new Date(draft.createdAt || Date.now()).toISOString(),
      user: COMMENT_AUTHOR,
    })
  }
  return result
}

/** 旧 TipTap 文档 → Canvas 主状态 + 旧修订批注。 */
export function legacyTipTapToCanvasWithComments(docJson: unknown): LegacyCanvasConversion {
  const root = docJson as (TipTapNode & { main?: unknown[] }) | null
  if (!root || typeof root !== 'object') {
    return { canvasData: { main: [] }, comments: [] }
  }
  // 已是 Canvas 结构（v2 但没有 comments 字段时）直接复用。
  if (Array.isArray(root.main) && root.type !== 'doc') {
    return { canvasData: { main: root.main as IElement[] }, comments: [] }
  }
  const drafts = new Map<string, LegacyCommentDraft>()
  const main: IElement[] = []
  for (const child of Array.isArray(root.content) ? root.content : []) {
    blockToElements(child, main, drafts)
  }
  while (main.length > 0 && main[main.length - 1]?.value === '\n') main.pop()
  if (main.length > 0) main.push({ value: '\n' })
  return { canvasData: { main }, comments: finalizeComments(drafts) }
}

export function legacyTipTapToCanvas(docJson: unknown): CsLabCanvasData {
  return legacyTipTapToCanvasWithComments(docJson).canvasData
}

// ===== Canvas → TipTap =====

function capsuleAttrsFromExtension(extension: CsLabCapsuleExtension): Record<string, unknown> {
  return {
    capsuleId: extension.capsuleId,
    label: extension.label,
    value: extension.value,
    unit: extension.unit,
    tableUri: extension.tableUri,
    column: extension.column,
    rowIndex: extension.rowIndex,
    revisionAtBind: extension.revisionAtBind,
    status: extension.status,
  }
}

function flattenValueList(element: IElement): IElement[] {
  if (Array.isArray(element.valueList) && element.valueList.length > 0) {
    return element.valueList as IElement[]
  }
  return [element]
}

interface RunState {
  key: string
  text: string
  marks: Array<Record<string, unknown>>
}

/** Canvas 主状态 → 派生 TipTap docJson（用于 .md / .docx 导出）。 */
export function canvasToTipTapDoc(
  canvasData: CsLabCanvasData,
  comments: CsLabManuscriptComment[] = [],
): unknown {
  const main = (Array.isArray(canvasData.main) ? canvasData.main : []) as IElement[]
  const commentMap = new Map(comments.map((comment) => [comment.id, comment]))

  const makeInlineNodes = (elements: IElement[]): Array<Record<string, unknown>> => {
    const nodes: Array<Record<string, unknown>> = []
    let run: RunState | null = null
    let lastCapsuleId: string | null = null

    const flush = (): void => {
      if (!run || !run.text) {
        run = null
        return
      }
      nodes.push({
        type: 'text',
        text: run.text,
        ...(run.marks.length > 0 ? { marks: run.marks } : {}),
      })
      run = null
    }

    const appendText = (
      text: string,
      style: { bold?: boolean; italic?: boolean; underline?: boolean; strikeout?: boolean; code?: boolean },
      commentIds: string[],
    ): void => {
      if (!text) return
      const key = [
        style.bold ? 'b' : '',
        style.italic ? 'i' : '',
        style.underline ? 'u' : '',
        style.strikeout ? 's' : '',
        style.code ? 'c' : '',
        commentIds.slice().sort().join(','),
      ].join('|')
      if (!run || run.key !== key) {
        flush()
        const marks: Array<Record<string, unknown>> = []
        if (style.bold) marks.push({ type: 'bold' })
        if (style.italic) marks.push({ type: 'italic' })
        if (style.underline) marks.push({ type: 'underline' })
        if (style.code) marks.push({ type: 'code' })
        for (const commentId of commentIds) {
          const comment = commentMap.get(commentId)
          if (!comment) continue
          marks.push({
            type: 'comment',
            attrs: {
              suggestionId: comment.id,
              commentText: comment.content,
              authorId: 'CDUT Science',
              authorName: 'CDUT Science',
              personaType: 'human',
              createdAt: Date.parse(comment.createdAt) || undefined,
            },
          })
        }
        run = { key, text: '', marks }
      }
      const pieces = text.split('\n')
      pieces.forEach((piece, index) => {
        if (piece) run!.text += piece
        if (index < pieces.length - 1) {
          flush()
          nodes.push({ type: 'hardBreak' })
        }
      })
    }

    for (const element of elements) {
      if (!element) continue

      if (isCapsuleValueElement(element)) {
        flush()
        const extension = capsuleExtensionOf(element)
        if (extension) {
          if (extension.capsuleId !== lastCapsuleId) {
            nodes.push({
              type: 'scienceCapsule',
              attrs: capsuleAttrsFromExtension(extension),
            })
          }
          lastCapsuleId = extension.capsuleId
        }
        continue
      }
      lastCapsuleId = null

      if (element.type === CsCanvasElementType.TITLE || element.type === CsCanvasElementType.LIST) {
        nodes.push(...makeInlineNodes(flattenValueList(element)))
        continue
      }
      if (element.type === CsCanvasElementType.CONTROL) {
        const controlValue = element.control?.value
        if (Array.isArray(controlValue) && controlValue.length > 0) {
          appendText(
            controlValue.map((item) => String(item.value ?? '')).join(''),
            {},
            [],
          )
        } else if (element.value) {
          appendText(String(element.value), {}, [])
        }
        continue
      }
      if (element.type === CsCanvasElementType.PAGE_BREAK) continue
      if (element.type === CsCanvasElementType.IMAGE) {
        appendText('[图片]', {}, [])
        continue
      }
      if (element.type === CsCanvasElementType.LATEX) {
        appendText('[公式]', {}, [])
        continue
      }
      if (element.type === CsCanvasElementType.TABLE) {
        appendText('[表格]', {}, [])
        continue
      }
      if (element.type === CsCanvasElementType.SEPARATOR) {
        appendText('———', {}, [])
        continue
      }

      const commentIds = (element.groupIds ?? []).filter((id) => commentMap.has(id))
      const font = String(element.font ?? '')
      appendText(
        String(element.value ?? ''),
        {
          bold: element.bold,
          italic: element.italic,
          underline: element.underline,
          strikeout: element.strikeout,
          code: /consolas|courier/i.test(font),
        },
        commentIds,
      )
    }
    flush()
    return nodes
  }

  const blocks: Array<Record<string, unknown>> = []
  let line: IElement[] = []

  const flushLine = (): void => {
    if (line.length === 0) {
      blocks.push({ type: 'paragraph', content: [] })
      return
    }
    const first = line[0]
    if (first?.type === CsCanvasElementType.TITLE) {
      const titleElement = line.find((element) => element.type === CsCanvasElementType.TITLE)
      const level =
        TITLE_LEVEL_TO_HEADING[String(titleElement?.level ?? 'first')] ?? 1
      blocks.push({
        type: 'heading',
        attrs: { level },
        content: makeInlineNodes(
          line.flatMap((element) =>
            element.type === CsCanvasElementType.TITLE ||
            element.type === CsCanvasElementType.LIST
              ? flattenValueList(element)
              : [element],
          ),
        ),
      })
      line = []
      return
    }
    if (first?.type === CsCanvasElementType.LIST) {
      const listType =
        first.listType === CsCanvasListType.OL ? 'orderedList' : 'bulletList'
      const item = {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: makeInlineNodes(
              line.flatMap((element) =>
                element.type === CsCanvasElementType.TITLE ||
                element.type === CsCanvasElementType.LIST
                  ? flattenValueList(element)
                  : [element],
              ),
            ),
          },
        ],
      }
      const previous = blocks[blocks.length - 1]
      if (previous && previous.type === listType) {
        ;(previous.content as Array<Record<string, unknown>>).push(item)
      } else {
        blocks.push({ type: listType, content: [item] })
      }
      line = []
      return
    }
    const expanded = line.flatMap((element) =>
      element.type === CsCanvasElementType.TITLE || element.type === CsCanvasElementType.LIST
        ? flattenValueList(element)
        : [element],
    )
    blocks.push({ type: 'paragraph', content: makeInlineNodes(expanded) })
    line = []
  }

  for (const element of main) {
    if (!element) continue
    if (element.value === '\n' && !element.type) {
      flushLine()
      continue
    }
    line.push(element)
  }
  flushLine()

  while (blocks.length > 0) {
    const last = blocks[blocks.length - 1]
    if (!last) break
    const content = last.content as Array<Record<string, unknown>> | undefined
    if (last.type === 'paragraph' && (!content || content.length === 0)) {
      blocks.pop()
      continue
    }
    break
  }

  return {
    type: 'doc',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
  }
}

// ===== 胶囊提取 =====

function capsuleAttrsFromElement(element: IElement): CsLabCapsuleAttrs | null {
  const extension = capsuleExtensionOf(element)
  if (!extension) return null
  return {
    capsuleId: extension.capsuleId,
    label: extension.label,
    value: extension.value,
    unit: extension.unit,
    tableUri: extension.tableUri,
    column: extension.column,
    rowIndex: extension.rowIndex,
    revisionAtBind: extension.revisionAtBind,
    status: extension.status,
  }
}

export function extractCanvasCapsules(
  canvasData: CsLabCanvasData,
  labId: string,
): CsLabCapsule[] {
  const main = (Array.isArray(canvasData.main) ? canvasData.main : []) as IElement[]
  const seen = new Set<string>()
  const result: CsLabCapsule[] = []
  const now = Date.now()

  for (const element of main) {
    if (!element) continue
    if (!isCapsuleValueElement(element) && element.type !== CsCanvasElementType.CONTROL) continue
    const attrs = capsuleAttrsFromElement(element)
    if (!attrs || !attrs.capsuleId || seen.has(attrs.capsuleId)) continue
    seen.add(attrs.capsuleId)
    result.push({
      id: attrs.capsuleId,
      labId,
      label: attrs.label,
      value: attrs.value,
      unit: attrs.unit || undefined,
      tableUri: attrs.tableUri,
      column: attrs.column,
      rowIndex: attrs.rowIndex,
      revisionAtBind: attrs.revisionAtBind,
      status: attrs.tableUri ? attrs.status : 'orphan',
      updatedAt: now,
    })
  }
  return result
}

// ===== 文本工具 =====

/** 提取正文纯文本（跳过控件 prefix/postfix 之外的噪音）。 */
export function extractCanvasText(canvasData: CsLabCanvasData): string {
  const main = (Array.isArray(canvasData.main) ? canvasData.main : []) as IElement[]
  const pieces: string[] = []
  for (const element of main) {
    if (!element) continue
    if (element.type === CsCanvasElementType.PAGE_BREAK) {
      pieces.push('\n')
      continue
    }
    if (element.type === CsCanvasElementType.TITLE || element.type === CsCanvasElementType.LIST) {
      pieces.push(flattenValueList(element).map((item) => String(item.value ?? '')).join(''))
      continue
    }
    if (element.type === CsCanvasElementType.CONTROL) {
      if (element.controlComponent === CsCanvasControlComponent.PREFIX) continue
      if (element.controlComponent === CsCanvasControlComponent.POSTFIX) continue
      const extension = capsuleExtensionOf(element)
      if (extension) {
        if (
          element.controlComponent === undefined ||
          element.controlComponent === CsCanvasControlComponent.VALUE
        ) {
          pieces.push(capsuleDisplayText({
            capsuleId: extension.capsuleId,
            label: extension.label,
            value: extension.value,
            unit: extension.unit,
            tableUri: extension.tableUri,
            column: extension.column,
            rowIndex: extension.rowIndex,
            revisionAtBind: extension.revisionAtBind,
            status: extension.status,
          }))
        }
        continue
      }
      if (element.value) pieces.push(String(element.value))
      continue
    }
    pieces.push(String(element.value ?? ''))
  }
  return pieces.join('')
}

/** 在正文中定位逐字片段；找不到返回 null（绝不模糊替换）。 */
export function findTextRange(
  main: IElement[],
  quote: string,
): { start: number; end: number } | null {
  const target = quote.replace(/\s+/g, ' ').trim()
  if (!target) return null

  let haystack = ''
  const indexMap: number[] = []
  let pendingSpace = false

  const pushChar = (char: string, elementIndex: number): void => {
    if (/\s/.test(char)) {
      pendingSpace = true
      return
    }
    if (pendingSpace && haystack.length > 0) {
      haystack += ' '
      indexMap.push(elementIndex)
    }
    pendingSpace = false
    haystack += char
    indexMap.push(elementIndex)
  }

  main.forEach((element, elementIndex) => {
    if (!element) return
    if (element.type === CsCanvasElementType.CONTROL) return
    if (element.type === CsCanvasElementType.PAGE_BREAK) return
    const elements =
      element.type === CsCanvasElementType.TITLE || element.type === CsCanvasElementType.LIST
        ? flattenValueList(element)
        : [element]
    for (const item of elements) {
      for (const char of Array.from(String(item.value ?? ''))) {
        pushChar(char, elementIndex)
      }
    }
  })

  const position = haystack.indexOf(target)
  if (position < 0) return null
  const start = indexMap[position]
  const end = indexMap[position + target.length - 1]
  if (start === undefined || end === undefined) return null
  return { start, end }
}
