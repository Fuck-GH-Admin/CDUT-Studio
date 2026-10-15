import { expect, test } from 'bun:test'
import { closeTab, getPersistableTabState, isMruEligibleId, openTab, orderTabsBySessionContext, promoteSessionMru, selectSameModeCloseFallback, tabContextSessionId, type TabItem } from './tab-atoms'

const tab = (id: string): TabItem => ({ id, type: 'agent', sessionId: id, title: id })

test('关闭当前普通标签时回退到最近访问标签而非右侧标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b'), tab('c')], 'c', 'c', ['c', 'b', 'a'])
  expect(result.activeTabId).toBe('b')
  expect(result.mru).toEqual(['b', 'a'])
})

test('关闭非当前标签不改变活动标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b')], 'a', 'b', ['a', 'b'])
  expect(result.activeTabId).toBe('a')
  expect(result.mru).toEqual(['a'])
})

test('同一会话可同时打开多个浏览器页 Tab，重复打开同一页只聚焦', () => {
  const agent = tab('s1')
  let state = openTab([agent], { type: 'browser', sessionId: 's1', title: '页 A', browserTabId: 'a' })
  state = openTab(state.tabs, { type: 'browser', sessionId: 's1', title: '页 B', browserTabId: 'b' })
  const browserTabs = state.tabs.filter((t) => t.type === 'browser')
  expect(browserTabs).toHaveLength(2)
  // owner 会话 Tab 位于首位（scratch 之后的第 2 位），工作 Tab 紧跟其后
  expect(state.tabs[1]?.id).toBe('s1')
  // 重复打开同一页：数量不变，聚焦既有 Tab
  const again = openTab(state.tabs, { type: 'browser', sessionId: 's1', title: '页 A', browserTabId: 'a' })
  expect(again.tabs.filter((t) => t.type === 'browser')).toHaveLength(2)
  expect(again.activeTabId).toBe(browserTabs.find((t) => t.browserTabId === 'a')!.id)
})

test('浏览器 Tab 每会话单例，重复打开只聚焦', () => {
  const agent = tab('s1')
  const first = openTab([agent], { type: 'browser', sessionId: 's1', title: '浏览器' })
  const second = openTab(first.tabs, { type: 'browser', sessionId: 's1', title: '浏览器' })
  expect(second.tabs.filter((t) => t.type === 'browser')).toHaveLength(1)
  expect(second.activeTabId).toBe(first.activeTabId)
})

test('关闭会话 Tab 时连带关闭其全部工作 Tab（浏览器×N）', () => {
  const agent = tab('s1')
  let state = openTab([agent], { type: 'browser', sessionId: 's1', title: '页 A', browserTabId: 'a' })
  state = openTab(state.tabs, { type: 'browser', sessionId: 's1', title: '页 B', browserTabId: 'b' })
  // 其它会话的工作 Tab 不受影响
  state = openTab(state.tabs, { type: 'agent', sessionId: 's2', title: 's2' })
  state = openTab(state.tabs, { type: 'browser', sessionId: 's2', title: '页 C', browserTabId: 'c' })
  const result = closeTab(state.tabs, 's1', 's1', ['s2', 's1'])
  expect(result.tabs.some((t) => t.sessionId === 's1')).toBe(false)
  expect(result.tabs.some((t) => t.sessionId === 's2' && t.type === 'browser')).toBe(true)
})

test('工作 Tab 不参与持久化，激活工作 Tab 时持久化回退到 owner 会话', () => {
  const agent = tab('s1')
  const state = openTab([agent], { type: 'browser', sessionId: 's1', title: '页 A', browserTabId: 'a' })
  const persisted = getPersistableTabState(state.tabs, state.activeTabId)
  expect(persisted.tabs.map((t) => t.id)).toEqual(['s1'])
  expect(persisted.activeTabId).toBe('s1')
})

test('打开会话不再丢弃其工作 Tab', () => {
  const agent = tab('s1')
  let state = openTab([agent], { type: 'browser', sessionId: 's1', title: '页 A', browserTabId: 'a' })
  state = openTab(state.tabs, { type: 'agent', sessionId: 's1', title: 's1' })
  expect(state.activeTabId).toBe('s1')
  expect(state.tabs.some((t) => t.type === 'browser' && t.sessionId === 's1')).toBe(true)
})

// ===== 子会话 Tab（parentSessionId 血缘）=====

test('打开子会话 Tab 携带 parentSessionId，且参与持久化', () => {
  const parent = tab('parent-1')
  const state = openTab([parent], { type: 'agent', sessionId: 'child-1', title: '子会话', parentSessionId: 'parent-1' })
  expect(state.tabs.find((t) => t.id === 'child-1')?.parentSessionId).toBe('parent-1')
  const persisted = getPersistableTabState(state.tabs, state.activeTabId)
  expect(persisted.tabs.map((t) => t.id)).toContain('child-1')
  expect(persisted.tabs.find((t) => t.id === 'child-1')?.parentSessionId).toBe('parent-1')
})

test('已存在的 Tab 补上血缘时不丢原数据', () => {
  const existing = tab('child-1')
  const state = openTab([tab('parent-1'), existing], { type: 'agent', sessionId: 'child-1', title: '子会话', parentSessionId: 'parent-1' })
  expect(state.tabs.find((t) => t.id === 'child-1')).toEqual({ ...existing, parentSessionId: 'parent-1' })
})

test('tabContextSessionId 沿血缘走到根会话', () => {
  const tabs: TabItem[] = [
    tab('root'),
    { ...tab('mid'), parentSessionId: 'root' },
    { ...tab('leaf'), parentSessionId: 'mid' },
  ]
  expect(tabContextSessionId(tabs, tabs[2]!)).toBe('root')
  expect(tabContextSessionId(tabs, tabs[1]!)).toBe('root')
  expect(tabContextSessionId(tabs, tabs[0]!)).toBe('root')
})

test('tabContextSessionId 在父 Tab 缺失或血缘成环时回退自身', () => {
  const orphan: TabItem = { ...tab('orphan'), parentSessionId: 'missing' }
  expect(tabContextSessionId([orphan], orphan)).toBe('orphan')
  const a: TabItem = { ...tab('a'), parentSessionId: 'b' }
  const b: TabItem = { ...tab('b'), parentSessionId: 'a' }
  expect(tabContextSessionId([a, b], a)).toBe('b')
  expect(tabContextSessionId([a, b], b)).toBe('a')
})

test('关闭回退：同类会话还在时优先 MRU 回退到同类，不跨模式', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const agentA = tab('agent-a')
  const chatC: TabItem = { ...tab('chat-c'), type: 'chat' }
  const remaining = [scratch, agentA, chatC]
  // 关闭 agent-b，引擎结果落到 chat-c，但还有 agent-a → 回退到 agent-a
  const closing = tab('agent-b')
  expect(selectSameModeCloseFallback(remaining, closing, true, ['chat-c', 'agent-a'], 'chat-c')).toBe('agent-a')
})

test('关闭回退：关闭最后一个 agent 时回 Scratch Pad，不跳 chat', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const chatC: TabItem = { ...tab('chat-c'), type: 'chat' }
  const remaining = [scratch, chatC]
  const closing = tab('agent-a')
  expect(selectSameModeCloseFallback(remaining, closing, true, ['chat-c', 'agent-a'], 'chat-c')).toBe('__scratch-pad__')
})

test('关闭回退：关闭最后一个 chat 时回 Scratch Pad，不跳 agent', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const agentA = tab('agent-a')
  const remaining = [scratch, agentA]
  const closing: TabItem = { ...tab('chat-c'), type: 'chat' }
  expect(selectSameModeCloseFallback(remaining, closing, true, ['agent-a', 'chat-c'], 'agent-a')).toBe('__scratch-pad__')
})

test('关闭回退：引擎结果已是同类/关闭工作 Tab/非激活关闭时不覆盖', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const agentA = tab('agent-a')
  const agentB = tab('agent-b')
  const remaining = [scratch, agentA, agentB]
  // 引擎已选同类 agent-b
  expect(selectSameModeCloseFallback(remaining, tab('agent-x'), true, ['agent-b'], 'agent-b')).toBeNull()
  // 关闭工作 Tab（browser）
  const browser: TabItem = { ...tab('b1'), type: 'browser' }
  expect(selectSameModeCloseFallback(remaining, browser, true, ['agent-b'], 'agent-b')).toBeNull()
  // 非激活关闭（active 没变）
  expect(selectSameModeCloseFallback(remaining, tab('agent-x'), false, ['chat-c'], 'chat-c')).toBeNull()
})

// ===== 全局多会话顶栏模型 =====

test('orderTabsBySessionContext 把子会话紧跟父会话排列', () => {
  const tabs: TabItem[] = [
    tab('root'),
    tab('other'),
    { ...tab('child'), parentSessionId: 'root' },
  ]
  expect(orderTabsBySessionContext(tabs).map((t) => t.id)).toEqual(['root', 'child', 'other'])
})

test('isMruEligibleId 排除后台常驻与工作 Tab', () => {
  expect(isMruEligibleId('session-1')).toBe(true)
  expect(isMruEligibleId('__scratch-pad__')).toBe(false)
  expect(isMruEligibleId('__tutorial__')).toBe(false)
  expect(isMruEligibleId('__browser__:s1:tab-1')).toBe(false)
  expect(isMruEligibleId(null)).toBe(false)
})

test('promoteSessionMru 只记录真实会话 ID', () => {
  expect(promoteSessionMru(['a'], '__scratch-pad__')).toEqual(['a'])
  expect(promoteSessionMru(['a'], 'b')).toEqual(['b', 'a'])
})

test('新打开带 parentSessionId 的子会话 Tab 时直接插入到父会话簇之后，同时保留手动排序顺序', () => {
  const initial: TabItem[] = [
    tab('parent-1'),
    tab('other-2'),
  ]
  const afterChild1 = openTab(initial, {
    type: 'agent',
    sessionId: 'child-1',
    title: '子会话 1',
    parentSessionId: 'parent-1',
  })
  expect(afterChild1.tabs.filter((t) => t.type === 'agent').map((t) => t.id)).toEqual([
    'parent-1',
    'child-1',
    'other-2',
  ])
  const afterChild2 = openTab(afterChild1.tabs, {
    type: 'agent',
    sessionId: 'child-2',
    title: '子会话 2',
    parentSessionId: 'parent-1',
  })
  expect(afterChild2.tabs.filter((t) => t.type === 'agent').map((t) => t.id)).toEqual([
    'parent-1',
    'child-1',
    'child-2',
    'other-2',
  ])
})

test('关闭当前激活的浏览器工作 Tab 时优先回退到所属宿主会话 Tab', () => {
  let state = openTab([tab('s1'), tab('s2')], {
    type: 'browser',
    sessionId: 's1',
    title: '浏览器页',
    browserTabId: 'page-1',
  })
  const browserTabId = state.activeTabId!
  // 即使 MRU 中 s2 在前，关闭 s1 的浏览器工作 Tab 也应优先回到宿主会话 s1
  const closed = closeTab(state.tabs, browserTabId, browserTabId, ['s2', 's1'])
  expect(closed.activeTabId).toBe('s1')
})

test('关闭非当前会话标签时保持教程 Tab 激活，教程不被连带关闭', () => {
  const scratch: TabItem = { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch' }
  const tutorial: TabItem = { id: '__tutorial__', type: 'tutorial', sessionId: '__tutorial__', title: 'CDUT Studio 使用教程' }
  const closed = closeTab([scratch, tutorial, tab('a')], '__tutorial__', 'a', ['a'])
  expect(closed.activeTabId).toBe('__tutorial__')
  expect(closed.tabs.some((t) => t.id === '__tutorial__')).toBe(true)
})
