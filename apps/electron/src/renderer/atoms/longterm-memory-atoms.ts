/**
 * 长期记忆图谱渲染层状态
 *
 * 所有 IPC 调用收敛在写入型 atom 中，UI 组件只消费状态，不直接碰 window.electronAPI。
 */

import { atom } from 'jotai'
import { toast } from 'sonner'
import type {
  LongTermMemoryCategory,
  LongTermMemoryGraph,
  LongTermMemoryHit,
  LongTermMemoryNode,
} from '@profer/shared'

/** 编辑草稿：id 为 null 表示新建 */
export interface LongTermMemoryDraft {
  id: string | null
  category: LongTermMemoryCategory
  title: string
  content: string
  /** 输入框原文，逗号 / 空格分隔 */
  tagsText: string
  confidence: number
}

export const longTermMemoryGraphAtom = atom<LongTermMemoryGraph | null>(null)
export const longTermMemoryLoadingAtom = atom(false)
export const longTermMemoryViewOpenAtom = atom(false)
export const longTermMemorySelectedIdAtom = atom<string | null>(null)
export const longTermMemoryDraftAtom = atom<LongTermMemoryDraft | null>(null)
export const longTermMemoryFilterAtom = atom<LongTermMemoryCategory | 'all'>('all')
export const longTermMemoryQueryAtom = atom('')
export const longTermMemoryHitsAtom = atom<LongTermMemoryHit[]>([])
export const longTermMemoryQueryingAtom = atom(false)

/** 从任意节点构造编辑草稿 */
export function draftFromNode(node: LongTermMemoryNode): LongTermMemoryDraft {
  return {
    id: node.id,
    category: node.category,
    title: node.title,
    content: node.content,
    tagsText: node.tags.join(', '),
    confidence: node.confidence,
  }
}

function parseTags(text: string): string[] {
  return text
    .split(/[,，;；\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/** 拉取全量图谱 */
export const refreshLongTermMemoryAtom = atom(null, async (_get, set) => {
  set(longTermMemoryLoadingAtom, true)
  try {
    const graph = await window.electronAPI.longTermMemory.getGraph()
    set(longTermMemoryGraphAtom, graph)
  } catch (error) {
    console.error('[长期记忆] 加载图谱失败:', error)
    toast.error('加载记忆图谱失败', {
      description: error instanceof Error ? error.message : String(error),
    })
  } finally {
    set(longTermMemoryLoadingAtom, false)
  }
})

/** 保存草稿（新建或编辑） */
export const saveLongTermMemoryDraftAtom = atom(null, async (get, set) => {
  const draft = get(longTermMemoryDraftAtom)
  if (!draft) return
  const title = draft.title.trim()
  const content = draft.content.trim()
  if (!content) {
    toast.error('记忆内容不能为空')
    return
  }

  try {
    if (draft.id) {
      const graph = get(longTermMemoryGraphAtom)
      const existing = graph?.nodes.find((node) => node.id === draft.id)
      if (!existing) {
        toast.error('该记忆已不存在，请刷新后重试')
        return
      }
      await window.electronAPI.longTermMemory.updateNode({
        ...existing,
        category: draft.category,
        title: title || content.slice(0, 24),
        content,
        tags: parseTags(draft.tagsText),
        confidence: draft.confidence,
      })
      set(longTermMemorySelectedIdAtom, draft.id)
    } else {
      const node = await window.electronAPI.longTermMemory.addNode({
        category: draft.category,
        title: title || content.slice(0, 24),
        content,
        tags: parseTags(draft.tagsText),
        confidence: draft.confidence,
      })
      set(longTermMemorySelectedIdAtom, node.id)
    }
    set(longTermMemoryDraftAtom, null)
    await set(refreshLongTermMemoryAtom)
    toast.success('记忆已保存')
  } catch (error) {
    console.error('[长期记忆] 保存失败:', error)
    toast.error('保存记忆失败', {
      description: error instanceof Error ? error.message : String(error),
    })
  }
})

/** 删除节点 */
export const deleteLongTermMemoryNodeAtom = atom(null, async (get, set, nodeId: string) => {
  try {
    const result = await window.electronAPI.longTermMemory.deleteNode(nodeId)
    if (!result.success) {
      toast.error('删除失败，该记忆可能已不存在')
      return
    }
    if (get(longTermMemorySelectedIdAtom) === nodeId) {
      set(longTermMemorySelectedIdAtom, null)
      set(longTermMemoryDraftAtom, null)
    }
    await set(refreshLongTermMemoryAtom)
    toast.success('记忆已删除')
  } catch (error) {
    console.error('[长期记忆] 删除失败:', error)
    toast.error('删除记忆失败', {
      description: error instanceof Error ? error.message : String(error),
    })
  }
})

/** 执行检索测试 */
export const runLongTermMemoryQueryTestAtom = atom(null, async (get, set) => {
  const query = get(longTermMemoryQueryAtom).trim()
  if (!query) {
    set(longTermMemoryHitsAtom, [])
    return
  }
  set(longTermMemoryQueryingAtom, true)
  try {
    const hits = await window.electronAPI.longTermMemory.queryTest({ query, topK: 6 })
    set(longTermMemoryHitsAtom, hits)
  } catch (error) {
    console.error('[长期记忆] 检索测试失败:', error)
    set(longTermMemoryHitsAtom, [])
    toast.error('检索测试失败', {
      description: error instanceof Error ? error.message : String(error),
    })
  } finally {
    set(longTermMemoryQueryingAtom, false)
  }
})
