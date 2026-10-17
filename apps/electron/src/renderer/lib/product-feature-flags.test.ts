/**
 * 工作区产品可见性测试
 *
 * 一个开关决定侧边栏切换器、TabSwitcher、规划中心、自动化表单等所有入口的一致性，
 * 所以这里要把两种不可见（用户收纳 / 团队开关）都钉死。
 */
import { describe, expect, test } from 'bun:test'
import {
  getVisibleAgentWorkspaces,
  isAgentWorkspaceIdVisible,
  isAgentWorkspaceVisible,
} from './product-feature-flags'

const personal = { id: 'p1', name: 'profer', type: 'personal' as const }
const personalArchived = { id: 'p2', name: 'blog管理', type: 'personal' as const, archived: true }
const defaultWs = { id: 'default-ws', name: '默认工作区', slug: 'default', type: 'personal' as const }
const team = { id: 't1', name: '持矢大队', type: 'team' as const }
const teamArchived = { id: 't2', name: '已收纳团队', type: 'team' as const, archived: true }

describe('工作区可见性', () => {
  test('活跃的个人工作区可见', () => {
    expect(isAgentWorkspaceVisible(personal)).toBe(true)
  })

  test('默认工作区（slug: default）在 UI 入口中不可见', () => {
    expect(isAgentWorkspaceVisible(defaultWs)).toBe(false)
  })

  test('已收纳的工作区不可见', () => {
    expect(isAgentWorkspaceVisible(personalArchived)).toBe(false)
  })

  test('团队工作区由产品开关统一隐藏（当前关闭）', () => {
    expect(isAgentWorkspaceVisible(team)).toBe(false)
  })

  test('已收纳的团队工作区同样不可见', () => {
    expect(isAgentWorkspaceVisible(teamArchived)).toBe(false)
  })

  test('缺少 type 的旧数据按个人工作区处理', () => {
    expect(isAgentWorkspaceVisible({} as { type?: undefined; archived?: boolean })).toBe(true)
  })

  test('过滤后只保留活跃个人工作区，且保持原顺序', () => {
    const visible = getVisibleAgentWorkspaces([personal, defaultWs, personalArchived, team, teamArchived])
    expect(visible.map((w) => w.id)).toEqual(['p1'])
  })

  test('返回新数组，不修改入参', () => {
    const input = [personal, personalArchived]
    const visible = getVisibleAgentWorkspaces(input)
    expect(visible).not.toBe(input)
    expect(input.length).toBe(2)
  })

  test('空输入返回空数组', () => {
    expect(getVisibleAgentWorkspaces([])).toEqual([])
  })
})

describe('isAgentWorkspaceIdVisible', () => {
  const workspaces = [personal, personalArchived, team]

  test('空 id 视为可见（不阻塞未绑定工作区的入口）', () => {
    expect(isAgentWorkspaceIdVisible(null, workspaces)).toBe(true)
    expect(isAgentWorkspaceIdVisible(undefined, workspaces)).toBe(true)
  })

  test('活跃个人工作区可见', () => {
    expect(isAgentWorkspaceIdVisible('p1', workspaces)).toBe(true)
  })

  test('已收纳工作区 id 不可见，用于拦截打开/更新其会话', () => {
    expect(isAgentWorkspaceIdVisible('p2', workspaces)).toBe(false)
  })

  test('团队工作区 id 不可见', () => {
    expect(isAgentWorkspaceIdVisible('t1', workspaces)).toBe(false)
  })

  test('默认工作区 id 视为可见（允许打开独立会话）', () => {
    const listWithDefault = [...workspaces, defaultWs]
    expect(isAgentWorkspaceIdVisible('default-ws', listWithDefault)).toBe(true)
  })

  test('列表中不存在的 id 视为可见，避免历史数据被误判', () => {
    expect(isAgentWorkspaceIdVisible('unknown', workspaces)).toBe(true)
  })
})
