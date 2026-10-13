/**
 * 智联万站（Yanhu Express）渲染层状态原子
 *
 * 主进程为标签拓扑的唯一数据源，通过 `yanhu:on-tabs-changed` 等通道广播；
 * 渲染层只消费广播结果，不自行推导拓扑，确保 UI 与原生视图始终一致。
 */

import { atom } from 'jotai'
import type { YanhuTabItem, YanhuTabsState } from '@profer/shared'

/** 标签拓扑（顺序 + 激活项，主进程广播） */
export const yanhuTabsAtom = atom<YanhuTabsState>({ tabs: [], activeTabId: '' })

/** 当前激活标签 ID */
export const yanhuActiveTabIdAtom = atom<string>((get) => get(yanhuTabsAtom).activeTabId)

/** 当前激活标签（派生；无匹配时为 null） */
export const yanhuActiveTabAtom = atom<YanhuTabItem | null>((get) => {
  const state = get(yanhuTabsAtom)
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
})

/** 标签加载态映射（tabId -> 是否加载中），驱动标签栏转圈指示 */
export const yanhuLoadingAtom = atom<Record<string, boolean>>({})
