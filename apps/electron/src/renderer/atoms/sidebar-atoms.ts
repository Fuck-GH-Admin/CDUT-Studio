/**
 * 侧边栏状态 Atoms
 *
 * 管理侧边栏视图模式（活跃 / 已归档）与后台静默自动归档的未读红点状态。
 */

import * as React from 'react'
import { atom, useSetAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** 侧边栏视图模式 */
export type SidebarViewMode = 'active' | 'archived'

/** 侧边栏视图模式（active = 显示活跃对话，archived = 显示已归档对话） */
export const sidebarViewModeAtom = atom<SidebarViewMode>('active')

/**
 * 已归档列表未读标记：后台静默自动归档产生新增归档时点亮，
 * 用户点开「已归档列表」视图后立即熄灭。
 */
export const archivedUnreadAtom = atom<boolean>(false)

/**
 * 全局订阅主进程「静默自动归档」广播，点亮未读红点。
 * 须在应用根部常驻挂载（AgentListenersInitializer），保证侧栏收起时事件不丢失。
 */
export function useArchivedUnreadSync(): null {
  const setArchivedUnread = useSetAtom(archivedUnreadAtom)
  React.useEffect(() => {
    let disposed = false
    const unsubscribe = window.electronAPI.onArchivedUnreadChanged((count) => {
      if (!disposed && count > 0) setArchivedUnread(true)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [setArchivedUnread])
  return null
}

/** 项目列表排序方式 */
export type WorkspaceSortMode = 'default' | 'recent' | 'name'

/** 项目列表排序方式（default = 默认/创建时间，recent = 最近更新，name = 名称） */
export const workspaceSortModeAtom = atomWithStorage<WorkspaceSortMode>(
  'profer-workspace-sort-mode',
  'default',
)

/** 项目列表高度（px），用户可拖拽调整，持久化到 localStorage */
export const projectListHeightAtom = atomWithStorage<number>(
  'profer-workspace-list-height',
  120,
)

/** 左侧边栏宽度（px），用户可拖拽调整，持久化到 localStorage */
export const leftSidebarWidthAtom = atomWithStorage<number>(
  'profer-left-sidebar-width',
  300,
)
