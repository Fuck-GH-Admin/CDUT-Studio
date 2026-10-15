/**
 * tab-activation — 顶栏标签「激活」的唯一权威入口
 *
 * 所有标签切换出口（点击顶栏、Ctrl+Tab、探索分支打开、欢迎页复用、菜单/IPC）
 * 统一调用 activateTabWithSideEffects，确保 appMode / currentAgentSessionId /
 * 前台浏览器所有权 / MRU / 定时任务表单收起等副作用只在一处维护。
 */

import type { useStore } from 'jotai'
import {
  activeTabIdAtom,
  openTab,
  promoteSessionMru,
  TUTORIAL_TAB_ID,
  TUTORIAL_TAB_TITLE,
  tabMruAtom,
  tabsAtom,
} from '@/atoms/tab-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { browserStateMapAtom } from '@/atoms/browser-atoms'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { isAgentWorkspaceIdVisible } from '@/lib/product-feature-flags'
import { syncActiveTabSideEffectsForStore } from '@/lib/active-tab-side-effects'
import { findTabGroup, focusGroupMember, replaceTabGroup, tabGroupsAtom } from '@/atoms/tab-group-atoms'

type JotaiStore = ReturnType<typeof useStore>

/**
 * 激活指定标签并同步全部副作用。
 *
 * @returns 是否成功激活（标签不存在或所属工作区不可见时返回 false）
 */
export function activateTabWithSideEffects(store: JotaiStore, tabId: string): boolean {
  const tab = store.get(tabsAtom).find((t) => t.id === tabId)
  if (!tab) return false

  if (tab.type === 'agent') {
    const session = store.get(agentSessionsAtom).find((s) => s.id === tab.sessionId)
    if (!isAgentWorkspaceIdVisible(session?.workspaceId, store.get(agentWorkspacesAtom))) return false
  }

  const bridge = window.electronAPI as Partial<typeof window.electronAPI>
  // agent / 浏览器 Tab 都绑定在 agent 会话上，必须同步声明前台所有权。
  if (typeof bridge.setAgentBrowserForeground === 'function') {
    bridge.setAgentBrowserForeground(tab.type === 'agent' || tab.type === 'browser' ? tab.sessionId : null)
  }
  // 浏览器页 Tab：激活 = 切换主进程当前页（原生视口按激活页渲染）
  if (tab.type === 'browser' && tab.browserTabId) {
    const browserState = store.get(browserStateMapAtom).get(tab.sessionId)
    if (browserState?.activeTabId !== tab.browserTabId && typeof bridge.selectAgentBrowserTab === 'function') {
      void bridge.selectAgentBrowserTab({ sessionId: tab.sessionId, tabId: tab.browserTabId }).catch(() => undefined)
    }
  }

  store.set(activeTabIdAtom, tabId)
  // 若被激活的标签属于某个分屏组合，同步刷新该组合的 focusedTabId
  const currentGroups = store.get(tabGroupsAtom)
  const memberGroup = findTabGroup(currentGroups, tabId)
  if (memberGroup) {
    const focusedGroup = focusGroupMember(memberGroup, tabId)
    if (focusedGroup && focusedGroup !== memberGroup) {
      store.set(tabGroupsAtom, replaceTabGroup(currentGroups, memberGroup, focusedGroup))
    }
  }
  store.set(tabMruAtom, (prev) => promoteSessionMru(prev, tab.sessionId))
  // 点击任意 tab 都关闭定时任务编辑表单（overlay 否则会盖在内容区上）
  store.set(automationFormAtom, { open: false, draft: null })
  syncActiveTabSideEffectsForStore(store, tab)
  return true
}

/**
 * 打开（或聚焦）使用指南教程 Tab，并统一处理全部副作用：
 * 切回对话视图、关闭定时任务表单、同步当前会话状态。
 */
export function openTutorialTab(store: JotaiStore): void {
  const result = openTab(store.get(tabsAtom), {
    type: 'tutorial',
    sessionId: TUTORIAL_TAB_ID,
    title: TUTORIAL_TAB_TITLE,
  })
  store.set(tabsAtom, result.tabs)
  store.set(activeViewAtom, 'conversations')
  activateTabWithSideEffects(store, result.activeTabId)
}
