/**
 * 面板自适应布局 — 状态原子
 *
 * 模型：面板的「展开意图 A」与「实际可见 B」分离。
 * A（agentSidePanelOpenAtom）只随用户手动操作变化；
 * B（本文件的 panelVisibilityAtom）由 usePanelAutoLayout 依据窗口宽度统一计算。
 * 组件只读共享状态，避免 MainArea / AppShell / TabBar 各自订阅窗口造成竞态。
 */

import { atom } from 'jotai'
import type { PanelVisibility } from '@/lib/panel-layout'
import { appModeAtom } from '@/atoms/app-mode'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'

/** 当前窗口宽度（px）。初始取渲染进程当前内宽；由 usePanelAutoLayout 的 resize 监听维护。 */
export const windowWidthAtom = atom<number>(
  typeof window !== 'undefined' ? window.innerWidth : 1200,
)

/**
 * 文件面板是否参与布局判定（agent 个人视图）。
 * 团队工作区、规划中心、Agent 技能、自动化表单等视图不渲染右侧文件面板，
 * 由 usePanelAutoLayout 依据 AppShell 传入的作用域同步。
 */
export const layoutScopeActiveAtom = atom<boolean>(true)

/**
 * 浏览器/文件面板当前实际可见性 B。
 * 初始视为「曾可见」，避免冷启动窗口刚好够宽时因滞后带产生死区（需多 50px 才显示）。
 */
export const panelVisibilityAtom = atom<PanelVisibility>({ filePanel: true })

/**
 * 右侧边栏容器是否应渲染（Agent 个人视图 + 有当前会话 + 非定时表单 + 对话视图）。
 * 单一事实源：AppShell 渲染容器、TabBar 预留窗口按钮槽位都读它，杜绝 138px 错位。
 */
export const rightSidePanelContainerAtom = atom<boolean>((get) => {
  if (get(appModeAtom) !== 'agent') return false
  if (!get(currentAgentSessionIdAtom)) return false
  if (get(automationFormAtom).open) return false
  if (get(activeViewAtom) !== 'conversations') return false
  return true
})

/** 右侧边栏是否真正可见（容器条件 + 窗口宽度足够的面板布局判定）。 */
export const rightSidePanelVisibleAtom = atom<boolean>((get) => {
  return get(rightSidePanelContainerAtom) && get(panelVisibilityAtom).filePanel
})
