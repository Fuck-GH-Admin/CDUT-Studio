/**
 * study-atoms 会话隔离单元测试
 *
 * 验证右栏 Tab 拓扑、生成状态以及工件摘要在会话间的严格隔离性。
 */

import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  aiClassGeneratingMapAtom,
  aiClassTabsMapAtom,
  aiClassArtifactsMapAtom,
  createAiClassHomeTab,
} from './study-atoms'

describe('study-atoms 会话状态隔离测试', () => {
  it('aiClassGeneratingMapAtom: 会话 A 生成中不影响会话 B', () => {
    const store = createStore()
    const sessionA = 'session-alpha'
    const sessionB = 'session-beta'

    // 会话 A 触发生成思维导图
    store.set(aiClassGeneratingMapAtom, (prev) => {
      const next = new Map(prev)
      next.set(sessionA, 'mindmap')
      return next
    })

    const generatingMap = store.get(aiClassGeneratingMapAtom)
    expect(generatingMap.get(sessionA)).toBe('mindmap')
    expect(generatingMap.get(sessionB)).toBeUndefined() // 会话 B 保持空闲状态
  })

  it('aiClassTabsMapAtom: 会话 A 添加的 Tab 不会串扰至会话 B', () => {
    const store = createStore()
    const sessionA = 'session-alpha'
    const sessionB = 'session-beta'

    const newTabA = {
      id: 'tab-mindmap-1',
      type: 'mindmap' as const,
      title: '高等数学导图',
      closable: true,
      data: { mindmapId: 'mm-1' },
    }

    // 会话 A 拥有 Home + 新导图 Tab
    store.set(aiClassTabsMapAtom, (prev) => {
      const next = new Map(prev)
      next.set(sessionA, [createAiClassHomeTab(), newTabA])
      return next
    })

    const tabsMap = store.get(aiClassTabsMapAtom)
    expect(tabsMap.get(sessionA)?.length).toBe(2)
    expect(tabsMap.get(sessionB)).toBeUndefined() // 会话 B 未受影响
  })

  it('aiClassArtifactsMapAtom: 工件摘要按会话隔离存储', () => {
    const store = createStore()
    const sessionA = 'session-alpha'
    const sessionB = 'session-beta'

    const summaryA = {
      id: 'mm-1',
      kind: 'mindmap' as const,
      title: '导图 A',
      createdAt: 1000,
      itemCount: 5,
    }

    store.set(aiClassArtifactsMapAtom, (prev) => {
      const next = new Map(prev)
      next.set(sessionA, [summaryA])
      return next
    })

    const artifactsMap = store.get(aiClassArtifactsMapAtom)
    expect(artifactsMap.get(sessionA)?.length).toBe(1)
    expect(artifactsMap.get(sessionB)).toBeUndefined()
  })
})
