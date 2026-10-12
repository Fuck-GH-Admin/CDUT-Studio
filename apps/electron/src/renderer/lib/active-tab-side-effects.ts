/**
 * active-tab-side-effects — 基于 Jotai store 的「激活标签副作用」同步
 *
 * 与 useSyncActiveTabSideEffects 共享同一套语义，供非 React 上下文
 * （activateTabWithSideEffects、菜单/IPC 回调）复用，避免两处细节漂移。
 * React 侧 hook 也委托到本函数，保证单一事实源。
 */

import type { useStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { currentConversationIdAtom } from '@/atoms/conversation-atoms'
import {
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { tabsAtom, type TabItem } from '@/atoms/tab-atoms'

type JotaiStore = ReturnType<typeof useStore>

export function syncActiveTabSideEffectsForStore(
  store: JotaiStore,
  newActiveTab: TabItem | null,
): void {
  if (!newActiveTab) {
    // 所有标签都已关闭
    store.set(currentConversationIdAtom, null)
    store.set(currentAgentSessionIdAtom, null)
    return
  }

  if (newActiveTab.type === 'chat') {
    // 兼容旧状态：Chat Tab 不再进入 Chat 页面，直接回到 Scratch Pad。
    store.set(appModeAtom, 'scratch')
    store.set(currentConversationIdAtom, null)
    store.set(currentAgentSessionIdAtom, null)
    return
  }

  if (newActiveTab.type === 'scratch' || newActiveTab.type === 'tutorial') {
    // 个人 Agent 模式下切到 Scratch Pad 时保持右侧文件面板不收起；
    // 团队工作区没有独立的 Scratch 内容区，必须退出团队视图，避免留下空 Agent 面板。
    store.set(currentConversationIdAtom, null)
    const currentWorkspaceId = store.get(currentAgentWorkspaceIdAtom)
    const currentWorkspace = store.get(agentWorkspacesAtom).find((workspace) => workspace.id === currentWorkspaceId)
    const currentSessionId = store.get(currentAgentSessionIdAtom)
    const currentSessionStillOpen = currentSessionId !== null && store.get(tabsAtom).some(
      (tab) => (tab.type === 'agent' || tab.type === 'browser') && tab.sessionId === currentSessionId,
    )
    if (currentWorkspace?.type === 'team') {
      store.set(appModeAtom, 'scratch')
      store.set(currentAgentSessionIdAtom, null)
    } else if (store.get(appModeAtom) !== 'agent' || !currentSessionStillOpen) {
      store.set(currentAgentSessionIdAtom, null)
    }
    return
  }

  // Agent 会话 / 浏览器工作 Tab
  store.set(appModeAtom, 'agent')
  store.set(currentAgentSessionIdAtom, newActiveTab.sessionId)
  store.set(currentConversationIdAtom, null)

  // 清除该会话的"已完成未查看"标记
  store.set(unviewedCompletedSessionIdsAtom, (prev) => {
    if (!prev.has(newActiveTab.sessionId)) return prev
    const next = new Set(prev)
    next.delete(newActiveTab.sessionId)
    return next
  })

  // 同步 workspace
  const session = store.get(agentSessionsAtom).find((s) => s.id === newActiveTab.sessionId)
  if (session?.workspaceId) {
    store.set(currentAgentWorkspaceIdAtom, session.workspaceId)
    window.electronAPI.updateSettings({ agentWorkspaceId: session.workspaceId }).catch(console.error)
  }
}
