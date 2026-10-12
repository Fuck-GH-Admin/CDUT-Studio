/**
 * useCloseTab — 统一的当前会话入口关闭逻辑
 *
 * 被 TabBar（×按钮/中键/组合关闭）、GlobalShortcuts（Cmd+W）共用，
 *
 * 关键行为：
 * - 关闭当前会话入口只回到同类会话或 Scratch Pad，不停止后台 Agent
 * - 运行中或阻塞中的会话继续通过左侧状态 indicator 恢复
 * - idle 状态的 Agent 会话在用户主动关闭 Tab 时清除完成提醒状态
 * - 真正删除/归档时由侧边栏路径负责清理 per-session 状态
 *
 * 实现约定（防竞态）：关闭链路全部从 Jotai store 实时读取 tabs / activeTabId / MRU，
 * 不再依赖 React 渲染闭包中的快照——旧实现下连续关闭（如关闭组合两个标签）会因闭包
 * 陈旧而复活已被关闭的标签。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import {
  tabsAtom,
  activeTabIdAtom,
  closeTab,
  isBrowserTab,
  selectSameModeCloseFallback,
  tabMinimapCacheAtom,
  tabMruAtom,
} from '@/atoms/tab-atoms'
import { browserPanelDismissedSessionIdsAtom, browserStateMapAtom } from '@/atoms/browser-atoms'
import {
  agentSessionsAtom,
  agentSessionIndicatorMapAtom,
  agentSDKMessagesCacheAtom,
  resolvedBlobMessagesAtom,
  deleteSessionMapEntry,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { useSyncActiveTabSideEffects } from '@/hooks/useSyncActiveTabSideEffects'

interface UseCloseTabReturn {
  /** 请求关闭单个会话入口 */
  requestClose: (tabId: string) => void
  /** 直接执行关闭 */
  executeClose: (tabId: string) => void
  /** 一次性批量关闭一组标签（分屏组合的关闭按钮） */
  requestCloseGroup: (tabIds: readonly string[]) => void
}

export function useCloseTab(): UseCloseTabReturn {
  const store = useStore()
  const syncActiveTabSideEffects = useSyncActiveTabSideEffects()

  const clearIdleAgentCompletionNotice = React.useCallback((sessionId: string) => {
    const indicatorMap = store.get(agentSessionIndicatorMapAtom)
    const status = indicatorMap.get(sessionId)
    // running 或 blocked 的会话仍需要侧边栏状态提示
    if (status === 'running' || status === 'blocked') return

    // 通过 IPC 清除持久化的 completedButUnconfirmed 和旧版 manualWorking 状态
    window.electronAPI.clearAgentCompletionState(sessionId)
      .then((updated) => {
        store.set(agentSessionsAtom, (prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      })
      .catch(console.error)

    store.set(unviewedCompletedSessionIdsAtom, (prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [store])

  const executeClose = React.useCallback((tabId: string) => {
    const tabs = store.get(tabsAtom)
    const activeTabId = store.get(activeTabIdAtom)
    const tabMru = store.get(tabMruAtom)
    const closingTab = tabs.find((t) => t.id === tabId)
    const result = closeTab(tabs, activeTabId, tabId, tabMru)
    // 关闭会话入口后的回退选择：同类会话优先（MRU），同类关完回 Scratch Pad，不跨模式跳转。
    const fallbackTabId = selectSameModeCloseFallback(
      result.tabs,
      closingTab,
      result.activeTabId !== activeTabId,
      tabMru,
      result.activeTabId,
    )
    const nextActiveTabId = fallbackTabId ?? result.activeTabId
    const nextResult = nextActiveTabId === result.activeTabId
      ? result
      : { ...result, activeTabId: nextActiveTabId }
    store.set(tabsAtom, nextResult.tabs)
    store.set(activeTabIdAtom, nextResult.activeTabId)
    store.set(tabMruAtom, result.mru)

    // 同步工作 Tab 的附属状态（含直接关闭浏览器 Tab，以及关闭会话/组合时级联移除的浏览器 Tab）：
    // - 直接关闭单个浏览器 Tab → 关闭对应网页；
    // - 任意会话的顶栏浏览器 Tab 归零时 → 隐藏原生浏览器视图并记入 dismissed。
    const removedBrowserTabs = tabs.filter(
      (t) => isBrowserTab(t) && !nextResult.tabs.some((nt) => nt.id === t.id),
    )
    if (removedBrowserTabs.length > 0) {
      if (closingTab && isBrowserTab(closingTab) && closingTab.browserTabId) {
        const browserSessionId = closingTab.sessionId
        void (window.electronAPI as Partial<typeof window.electronAPI>)
          .closeAgentBrowserTab?.({ sessionId: browserSessionId, tabId: closingTab.browserTabId })
          .then((nextState) => {
            if (nextState !== null) return
            store.set(browserStateMapAtom, (prev) => {
              if (!prev.has(browserSessionId)) return prev
              const next = new Map(prev)
              next.delete(browserSessionId)
              return next
            })
          })
          .catch(() => undefined)
      }

      const affectedBrowserSessionIds = new Set(removedBrowserTabs.map((t) => t.sessionId))
      for (const bSessionId of affectedBrowserSessionIds) {
        const remainingBrowserTabs = nextResult.tabs.filter(
          (tab) => isBrowserTab(tab) && tab.sessionId === bSessionId,
        )
        if (remainingBrowserTabs.length === 0) {
          void (window.electronAPI as Partial<typeof window.electronAPI>).hideAgentBrowser?.(bSessionId)
          store.set(browserPanelDismissedSessionIdsAtom, (prev) => {
            if (prev.has(bSessionId)) return prev
            const next = new Set(prev)
            next.add(bSessionId)
            return next
          })
        }
      }
    }

    // 只要激活 Tab 发生了变化，就重建附属状态（当前会话跟随、右侧面板等）
    if (nextResult.activeTabId !== activeTabId) {
      const newActiveTab = nextResult.activeTabId
        ? nextResult.tabs.find((t) => t.id === nextResult.activeTabId) ?? null
        : null
      syncActiveTabSideEffects(newActiveTab)
    }

    // 关闭 Agent Tab 不停止后台 Agent，但要释放可从磁盘/实时消息重建的重型缓存。
    // 否则会话虽从界面关闭，完整消息数组和用户主动加载的全文 blob 仍一直驻留到进程重启。
    if (closingTab && closingTab.type === 'agent') {
      const sessionId = closingTab.sessionId
      store.set(agentSDKMessagesCacheAtom, (prev) => deleteSessionMapEntry(prev, sessionId))
      store.set(resolvedBlobMessagesAtom, (prev) => deleteSessionMapEntry(prev, sessionId))
      store.set(tabMinimapCacheAtom, (prev) => deleteSessionMapEntry(prev, sessionId))
      clearIdleAgentCompletionNotice(sessionId)
    }
  }, [store, syncActiveTabSideEffects, clearIdleAgentCompletionNotice])

  const requestClose = React.useCallback((tabId: string) => {
    executeClose(tabId)
  }, [executeClose])

  const requestCloseGroup = React.useCallback((tabIds: readonly string[]) => {
    // 逐个基于 store 实时状态关闭：第一个关闭引起的重排不会让后续标签被"复活"。
    for (const tabId of tabIds) executeClose(tabId)
  }, [executeClose])

  return { requestClose, executeClose, requestCloseGroup }
}
