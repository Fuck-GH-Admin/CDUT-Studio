/**
 * CSLab 活体胶囊 TipTap Node
 *
 * 采用 inline + atom 节点：不破坏正文扁平文本流，光标不会在边界卡死。
 * 一键更新只允许走 setNodeMarkup + addToHistory=false 精准事务（审计红线）。
 */

import { Node, mergeAttributes } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { CsLabCapsule, CsLabCapsuleStatus } from '@profer/shared'

export interface CapsuleNodeAttrs {
  capsuleId: string
  label: string
  value: string
  unit: string
  tableUri: string
  column: string
  rowIndex: number
  revisionAtBind: number
  status: CsLabCapsuleStatus
}

export const ScienceCapsuleNode = Node.create({
  name: 'scienceCapsule',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      capsuleId: { default: '' },
      label: { default: '' },
      value: { default: '' },
      unit: { default: '' },
      tableUri: { default: '' },
      column: { default: '' },
      rowIndex: { default: 0 },
      revisionAtBind: { default: 0 },
      status: { default: 'fresh' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-capsule-id]',
        getAttrs: (element) => {
          const node = element as HTMLElement
          const capsuleId = node.getAttribute('data-capsule-id')
          if (!capsuleId) return false
          return {
            capsuleId,
            label: node.getAttribute('data-label') ?? '',
            value: node.getAttribute('data-value') ?? '',
            unit: node.getAttribute('data-unit') ?? '',
            tableUri: node.getAttribute('data-table-uri') ?? '',
            column: node.getAttribute('data-column') ?? '',
            rowIndex: Number(node.getAttribute('data-row-index') ?? 0),
            revisionAtBind: Number(node.getAttribute('data-revision') ?? 0),
            status: (node.getAttribute('data-status') as CsLabCapsuleStatus) ?? 'fresh',
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as CapsuleNodeAttrs
    const stale = attrs.status === 'stale'
    const orphan = attrs.status === 'orphan'
    const className = stale
      ? 'cslab-capsule inline-flex items-center gap-1 rounded-full border border-amber-400/70 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 animate-pulse align-baseline cursor-pointer'
      : orphan
        ? 'cslab-capsule inline-flex items-center gap-1 rounded-full border border-cslab-border bg-cslab-surface px-2 py-0.5 text-[11px] font-medium text-cslab-muted align-baseline cursor-pointer'
        : 'cslab-capsule inline-flex items-center gap-1 rounded-full border border-cslab-accent/30 bg-cslab-accent/10 px-2 py-0.5 text-[11px] font-medium text-cslab-accent align-baseline cursor-pointer'

    const display = [attrs.label || '数据', attrs.value, attrs.unit].filter(Boolean).join(' ')

    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: className,
        'data-capsule-id': attrs.capsuleId,
        'data-label': attrs.label,
        'data-value': attrs.value,
        'data-unit': attrs.unit,
        'data-table-uri': attrs.tableUri,
        'data-column': attrs.column,
        'data-row-index': String(attrs.rowIndex),
        'data-revision': String(attrs.revisionAtBind),
        'data-status': attrs.status,
        title: attrs.tableUri
          ? `${attrs.tableUri}#${attrs.column}:${attrs.rowIndex}`
          : '未绑定数据表的胶囊',
      }),
      display,
    ]
  },
})

/** 从 TipTap JSON 中收集胶囊（保存文稿时使用）。 */
export function collectCapsulesFromDoc(docJson: unknown, labId: string): CsLabCapsule[] {
  const result: CsLabCapsule[] = []
  const now = Date.now()

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as {
      type?: string
      attrs?: Record<string, unknown>
      content?: unknown[]
    }
    if (record.type === 'scienceCapsule') {
      const attrs = record.attrs ?? {}
      const tableUri = String(attrs.tableUri ?? '')
      result.push({
        id: String(attrs.capsuleId ?? ''),
        labId,
        label: String(attrs.label ?? ''),
        value: String(attrs.value ?? ''),
        unit: attrs.unit ? String(attrs.unit) : undefined,
        tableUri,
        column: String(attrs.column ?? ''),
        rowIndex: Number(attrs.rowIndex ?? 0),
        revisionAtBind: Number(attrs.revisionAtBind ?? 0),
        status: tableUri
          ? ((attrs.status as CsLabCapsuleStatus) ?? 'fresh')
          : 'orphan',
        updatedAt: now,
      })
    }
    if (Array.isArray(record.content)) record.content.forEach(walk)
  }

  walk(docJson)
  return result.filter((capsule) => capsule.id)
}

/** 找到胶囊节点的绝对位置。 */
export function findCapsulePositions(editor: Editor): Map<string, number> {
  const positions = new Map<string, number>()
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'scienceCapsule') {
      positions.set(String(node.attrs.capsuleId ?? ''), pos)
    }
    return true
  })
  return positions
}

/** 用一行精准事务批量更新胶囊属性（不污染 Undo 栈、不改变焦点）。 */
export function patchCapsuleAttrs(
  editor: Editor,
  patches: Map<string, Partial<CapsuleNodeAttrs>>,
): boolean {
  if (patches.size === 0) return false
  const positions = findCapsulePositions(editor)
  const tr = editor.state.tr
  let changed = false

  for (const [capsuleId, patch] of patches) {
    const pos = positions.get(capsuleId)
    if (pos == null) continue
    const node = editor.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'scienceCapsule') continue
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch })
    changed = true
  }

  if (!changed) return false
  tr.setMeta('addToHistory', false)
  tr.setMeta('cslab-capsule-update', true)
  editor.view.dispatch(tr)
  return true
}

/** 将指定胶囊标记为 stale（数据表 revision 变化时）。 */
export function markCapsulesStale(editor: Editor, staleIds: Set<string>): void {
  const patches = new Map<string, Partial<CapsuleNodeAttrs>>()
  for (const id of staleIds) patches.set(id, { status: 'stale' })
  patchCapsuleAttrs(editor, patches)
}

/** 一键更新后写回真实值与绑定 revision。 */
export function applyUpdatedCapsule(editor: Editor, capsule: CsLabCapsule): void {
  patchCapsuleAttrs(
    editor,
    new Map([
      [
        capsule.id,
        {
          value: capsule.value,
          revisionAtBind: capsule.revisionAtBind,
          status: 'fresh',
        },
      ],
    ]),
  )
}
