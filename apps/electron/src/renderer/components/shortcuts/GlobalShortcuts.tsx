/**
 * GlobalShortcuts — 全局快捷键注册 + 初始化组件
 *
 * 在 main.tsx 顶层挂载（类似 AgentListenersInitializer），永不销毁。
 * 负责：
 * 1. 初始化快捷键注册表
 * 2. 从 settings 加载用户自定义配置
 * 3. 注册所有应用级快捷键的 handler
 * 4. 监听菜单 IPC 事件（Cmd+W 关闭标签）
 */

import { useEffect, useCallback } from 'react'
import { useAtomValue, useSetAtom, useAtom, useStore } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import { settingsOpenAtom, channelFormDirtyAtom, settingsCloseRequestedAtom } from '@/atoms/settings-tab'
import { searchDialogOpenAtom } from '@/atoms/search-atoms'
import {
  tabsAtom,
  activeTabIdAtom,
  sidebarCollapsedAtom,
  openTab,
  visibleTopBarTabsAtom,
} from '@/atoms/tab-atoms'
import { shortcutOverridesAtom, sendWithCmdEnterAtom } from '@/atoms/shortcut-atoms'
import { activateTabWithSideEffects } from '@/lib/tab-activation'
import {
  agentSessionsAtom,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { useCreateSession } from '@/hooks/useCreateSession'
import { useShortcut } from '@/hooks/useShortcut'
import { useCloseTab } from '@/hooks/useCloseTab'
import {
  initShortcutRegistry,
  updateShortcutOverrides,
} from '@/lib/shortcut-registry'

/**
 * 快捷键初始化 + 全局 Handler 注册
 *
 * 挂载后从 settings 加载自定义配置，并注册所有应用级快捷键。
 */
export function GlobalShortcuts(): null {
  const [appMode, setAppMode] = useAtom(appModeAtom)
  const [settingsOpen, setSettingsOpen] = useAtom(settingsOpenAtom)
  const channelFormDirty = useAtomValue(channelFormDirtyAtom)
  const setSettingsCloseRequested = useSetAtom(settingsCloseRequestedAtom)
  const [searchOpen, setSearchOpen] = useAtom(searchDialogOpenAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const setShortcutOverrides = useSetAtom(shortcutOverridesAtom)
  const shortcutOverrides = useAtomValue(shortcutOverridesAtom)
  const setSendWithCmdEnter = useSetAtom(sendWithCmdEnterAtom)
  const { createAgent } = useCreateSession()

  // Tab 管理（用于关闭标签页与顶栏可见序列对齐）
  const activeTabId = useAtomValue(activeTabIdAtom)
  useAtomValue(visibleTopBarTabsAtom)

  // 统一关闭逻辑：与 TabBar.handleClose 共用
  // 含 Agent 子进程 stop + 流式中的确认对话框（修复 Issue #357）
  const { requestClose } = useCloseTab()
  const store = useStore()

  // 初始化：挂载注册表 + 加载用户配置
  useEffect(() => {
    initShortcutRegistry()

    window.electronAPI.getSettings().then((settings) => {
      if (settings.shortcutOverrides) {
        setShortcutOverrides(settings.shortcutOverrides)
        updateShortcutOverrides(settings.shortcutOverrides)
      }
      setSendWithCmdEnter(settings.sendWithCmdEnter ?? false)
    }).catch(console.error)
  }, [setShortcutOverrides, setSendWithCmdEnter])

  // 配置变更时同步到注册表
  useEffect(() => {
    updateShortcutOverrides(shortcutOverrides)
  }, [shortcutOverrides])

  // ===== 关闭标签页逻辑 =====

  const handleCloseTab = useCallback(() => {
    // 浮窗优先：有浮窗打开时 Cmd+W 先关闭浮窗而非 tab
    if (settingsOpen) {
      // 渠道表单有未保存内容时，通知 SettingsPanel 弹出确认对话框
      if (channelFormDirty) {
        setSettingsCloseRequested(true)
        return
      }
      setSettingsOpen(false)
      return
    }
    if (searchOpen) {
      setSearchOpen(false)
      return
    }

    const currentActiveId = store.get(activeTabIdAtom) ?? activeTabId
    if (!currentActiveId) return
    requestClose(currentActiveId)
  }, [settingsOpen, setSettingsOpen, channelFormDirty, setSettingsCloseRequested, searchOpen, setSearchOpen, activeTabId, requestClose, store])

  // 监听菜单 IPC 事件（Cmd+W 被 Electron 菜单拦截后通过 IPC 转发）
  useEffect(() => {
    const cleanup = window.electronAPI.onMenuCloseTab(handleCloseTab)
    return cleanup
  }, [handleCloseTab])

  // 同时注册到快捷键系统（用于设置面板展示和自定义，实际触发走 IPC）
  useShortcut('close-tab', handleCloseTab)

  // ===== 快捷键 Handler =====

  // Cmd+, → 打开设置
  useShortcut(
    'open-settings',
    useCallback(() => setSettingsOpen(true), [setSettingsOpen]),
  )

  // Cmd+Shift+F / Ctrl+Shift+F → 全局搜索
  useShortcut(
    'global-search',
    useCallback(() => setSearchOpen(true), [setSearchOpen]),
  )

  // Cmd+N → 新建 Agent 会话
  useShortcut(
    'new-session',
    useCallback(() => {
      createAgent({ draft: true })
    }, [createAgent]),
  )

  // Cmd+B → 切换侧边栏
  useShortcut(
    'toggle-sidebar',
    useCallback(
      () => setSidebarCollapsed(!sidebarCollapsed),
      [sidebarCollapsed, setSidebarCollapsed],
    ),
  )

  // Cmd+Shift+M → 保留快捷键注册，但不再切换到已移除的 Chat 模式
  useShortcut(
    'toggle-mode',
    useCallback(() => setAppMode(appMode === 'scratch' ? 'agent' : 'scratch'), [appMode, setAppMode]),
  )

  // Cmd+K → 清除上下文（通过 CustomEvent 分发到 ChatInput）
  useShortcut(
    'clear-context',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('profer:clear-context'))
    }, []),
  )

  // Cmd+L → 聚焦输入框（通过 CustomEvent 分发到 ChatInput/AgentView）
  useShortcut(
    'focus-input',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('profer:focus-input'))
    }, []),
  )

  // Cmd+Shift+Backspace → 停止 Agent（通过 CustomEvent 分发到 ChatView/AgentView）
  useShortcut(
    'stop-generation',
    useCallback(() => {
      window.dispatchEvent(new CustomEvent('profer:stop-generation'))
    }, []),
  )

  // ===== 菜单栏 → 打开 / 创建会话 =====

  useEffect(() => {
    const cleanupOpen = window.electronAPI.onTrayOpenAgentSession(async (data) => {
      try {
        const sessions = await window.electronAPI.listAgentSessions()
        const session = sessions.find((item) => item.id === data.sessionId)
        if (!session) return

        store.set(agentSessionsAtom, sessions)
        store.set(activeViewAtom, 'conversations')

        const currentTabs = store.get(tabsAtom)
        const lineageParentId = session.parentSessionId ?? session.explorationParentSessionId
        const result = openTab(currentTabs, {
          type: 'agent',
          sessionId: session.id,
          title: session.title || data.title,
          ...(lineageParentId ? { parentSessionId: lineageParentId } : {}),
        })
        store.set(tabsAtom, result.tabs)
        activateTabWithSideEffects(store, result.activeTabId)
      } catch (error) {
        console.error('[菜单栏] 打开 Agent 会话失败:', error)
      }
    })

    const cleanupCreate = window.electronAPI.onTrayCreateSession(async () => {
      store.set(appModeAtom, 'agent')
      store.set(activeViewAtom, 'conversations')
      await createAgent()
    })

    return () => {
      cleanupOpen()
      cleanupCreate()
    }
  }, [store, createAgent])
  return null
}
