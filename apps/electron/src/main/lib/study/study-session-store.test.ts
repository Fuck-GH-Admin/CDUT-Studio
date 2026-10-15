/**
 * 速课堂多 Tab 拓扑归一化单测（BDD-TAB-01）
 *
 * 仅覆盖纯函数：首页恒居首位且不可关闭、activeTabId 越界回退、动态标签保留顺序。
 */

import { describe, expect, test } from 'bun:test'
import { AI_CLASS_HOME_TAB_ID, type AiClassRightTabItem } from '@profer/shared'
import { createHomeTab, normalizeTabsState } from './study-session-store'

const dynamicTab = (id: string, type: AiClassRightTabItem['type'] = 'mindmap'): AiClassRightTabItem => ({
  id,
  type,
  title: id,
  closable: true,
  data: {},
})

describe('速课堂多 Tab 拓扑归一化（BDD-TAB-01）', () => {
  test('首页恒居首位且不可关闭', () => {
    const state = normalizeTabsState('s1', [dynamicTab('t1'), dynamicTab('t2')], 't1')
    expect(state.tabs[0]?.id).toBe(AI_CLASS_HOME_TAB_ID)
    expect(state.tabs[0]?.closable).toBe(false)
    expect(state.tabs.map((t) => t.id)).toEqual([AI_CLASS_HOME_TAB_ID, 't1', 't2'])
  })

  test('混入的伪造 home 标签被剔除，仅保留唯一固定首页', () => {
    const fakeHome: AiClassRightTabItem = { id: 'tab-home-2', type: 'home', title: '伪首页', closable: true, data: {} }
    const state = normalizeTabsState('s1', [fakeHome, dynamicTab('t1')], 't1')
    expect(state.tabs.filter((t) => t.type === 'home')).toHaveLength(1)
    expect(state.tabs[0]?.id).toBe(AI_CLASS_HOME_TAB_ID)
  })

  test('activeTabId 指向已关闭标签时回退到首页', () => {
    const state = normalizeTabsState('s1', [dynamicTab('t1')], 'ghost')
    expect(state.activeTabId).toBe(AI_CLASS_HOME_TAB_ID)
  })

  test('createHomeTab 返回不可关闭的固定首页', () => {
    const home = createHomeTab()
    expect(home.id).toBe(AI_CLASS_HOME_TAB_ID)
    expect(home.type).toBe('home')
    expect(home.closable).toBe(false)
  })
})
