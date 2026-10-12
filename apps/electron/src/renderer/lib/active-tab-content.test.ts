/**
 * 主区空态与顶栏可见性回归测试
 *
 * 覆盖历史缺陷：
 * 1. 教程 Tab 被误判为「无内容」→ 打开教程 / 关闭最后一个会话后，主区渲染成新建会话启动页；
 * 2. 教程 Tab 仅在被激活时可见 → 一旦切走即从顶栏消失，无法再次进入。
 */
import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { resolveContentTabId, shouldShowWelcomeLauncher } from './active-tab-content'
import {
  activeTabIdAtom,
  tabsAtom,
  visibleTopBarTabsAtom,
  SCRATCH_PAD_ID,
  TUTORIAL_TAB_ID,
  type TabItem,
} from '@/atoms/tab-atoms'

const scratch: TabItem = { id: SCRATCH_PAD_ID, type: 'scratch', sessionId: SCRATCH_PAD_ID, title: 'Scratch Pad' }
const tutorial: TabItem = { id: TUTORIAL_TAB_ID, type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'CDUT Studio 使用教程' }
const agent = (id: string): TabItem => ({ id, type: 'agent', sessionId: id, title: id })

describe('主区空态判定', () => {
  test('仅有教程 Tab 激活时不显示新建会话启动页', () => {
    expect(shouldShowWelcomeLauncher([scratch, tutorial], TUTORIAL_TAB_ID)).toBe(false)
  })

  test('关闭最后一个会话、只剩教程时仍不显示启动页', () => {
    expect(shouldShowWelcomeLauncher([scratch, tutorial], TUTORIAL_TAB_ID)).toBe(false)
  })

  test('仅 Scratch Pad 激活时不显示启动页', () => {
    expect(shouldShowWelcomeLauncher([scratch], SCRATCH_PAD_ID)).toBe(false)
  })

  test('存在会话标签时不显示启动页', () => {
    expect(shouldShowWelcomeLauncher([scratch, agent('a')], 'a')).toBe(false)
  })

  test('无任何标签时才显示启动页', () => {
    expect(shouldShowWelcomeLauncher([], null)).toBe(true)
  })

  test('教程激活且无会话时，内容 Tab 解析为教程自身', () => {
    expect(resolveContentTabId([scratch, tutorial], TUTORIAL_TAB_ID)).toBe(TUTORIAL_TAB_ID)
  })
})

describe('顶栏标签可见性', () => {
  test('教程 Tab 常驻可见，切换到其他标签后仍可点回', () => {
    const store = createStore()
    store.set(tabsAtom, [scratch, agent('a'), tutorial])
    store.set(activeTabIdAtom, 'a')
    expect(store.get(visibleTopBarTabsAtom).some((tab) => tab.id === TUTORIAL_TAB_ID)).toBe(true)
  })

  test('Scratch Pad 在未激活时仍保持隐藏', () => {
    const store = createStore()
    store.set(tabsAtom, [scratch, agent('a'), tutorial])
    store.set(activeTabIdAtom, 'a')
    expect(store.get(visibleTopBarTabsAtom).some((tab) => tab.id === SCRATCH_PAD_ID)).toBe(false)
  })
})
