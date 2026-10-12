/**
 * WelcomeView — 主区域空状态启动器
 *
 * 当没有打开任何标签页时：
 * 1. 优先复用现有会话（打开最近的一个）
 * 2. 没有现有会话时，创建一个 draft 会话（不在侧边栏显示）
 *
 * 这样用户直接看到完整的 AgentView（含全功能输入框），
 * 发送第一条消息后 draft 标记自动移除，会话出现在侧边栏。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useStore } from 'jotai'
import { Loader2 } from 'lucide-react'
import { agentSessionsAtom, currentAgentWorkspaceIdAtom, agentSettingsReadyAtom } from '@/atoms/agent-atoms'
import { upsertAgentSession } from '@/lib/agent-session-list'
import { tabsAtom, openTab } from '@/atoms/tab-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { activateTabWithSideEffects } from '@/lib/tab-activation'
import { useCreateSession } from '@/hooks/useCreateSession'

export function WelcomeView(): React.ReactElement {
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const agentSettingsReady = useAtomValue(agentSettingsReadyAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const { createAgent } = useCreateSession()
  const store = useStore()
  const initRef = React.useRef<string | null>(null)

  // 将高频变化的值收集到 ref 中，避免污染 useEffect 依赖数组（否则 tabs/draftSessionIds
  // 引用变化会导致重复触发，而 createAgent 每次渲染都是新引用）
  const latestRef = React.useRef({
    tabs,
    draftSessionIds,
    currentWorkspaceId,
    setTabs,
    createAgent,
  })
  latestRef.current = {
    tabs,
    draftSessionIds,
    currentWorkspaceId,
    setTabs,
    createAgent,
  }

  React.useEffect(() => {
    // Agent 模式需等待 settings 就绪（workspaceId 等异步加载完成）
    if (!agentSettingsReady) return
    if (initRef.current === 'agent') return
    initRef.current = 'agent'

    // Agent 模式：按当前工作区复用现有会话，没有则创建 draft。
    window.electronAPI.listAgentSessions().then((freshSessions) => {
      if (initRef.current !== 'agent') return
      const {
        tabs: currentTabs,
        draftSessionIds: currentDrafts,
        currentWorkspaceId: currentWs,
        setTabs: currentSetTabs,
        createAgent: currentCreateAgent,
      } = latestRef.current

      const existing = freshSessions.find(
        (s) => !s.archived && !s.draft && s.workspaceId === currentWs && !currentDrafts.has(s.id),
      )
      if (existing) {
        const result = openTab(currentTabs, {
          type: 'agent',
          sessionId: existing.id,
          title: existing.title,
        })
        store.set(agentSessionsAtom, (prev) => upsertAgentSession(prev, existing))
        store.set(tabsAtom, result.tabs)
        currentSetTabs(result.tabs)
        // 统一激活入口：同步 currentAgentSessionId / workspace / 前台所有权，
        // 否则复用空会话时右侧边栏拿不到当前会话，无法打开。
        activateTabWithSideEffects(store, result.activeTabId)
        return
      }
      currentCreateAgent({ draft: true })
    }).catch(console.error)
  }, [agentSettingsReady])

  // 短暂的过渡状态（通常几十毫秒内就会被 TabContent 替换）
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground/40" />
    </div>
  )
}
