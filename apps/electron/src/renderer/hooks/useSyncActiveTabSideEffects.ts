/**
 * useSyncActiveTabSideEffects — 将"新激活标签"的副作用同步到全局原子
 *
 * 标签页切换/关闭时，需要把 appMode、currentConversationId、
 * currentAgentSessionId、currentAgentWorkspaceId、unviewedCompletedSessionIds
 * 等全局状态同步到新激活的标签。语义集中在 lib/active-tab-side-effects，
 * 本 hook 仅做 store 绑定，避免多处细节漂移。
 */

import { useCallback } from 'react'
import { useStore } from 'jotai'
import type { TabItem } from '@/atoms/tab-atoms'
import { syncActiveTabSideEffectsForStore } from '@/lib/active-tab-side-effects'

export type SyncActiveTabSideEffects = (newActiveTab: TabItem | null) => void

export function useSyncActiveTabSideEffects(): SyncActiveTabSideEffects {
  const store = useStore()

  return useCallback<SyncActiveTabSideEffects>(
    (newActiveTab) => {
      syncActiveTabSideEffectsForStore(store, newActiveTab)
    },
    [store],
  )
}
