import { describe, expect, test } from 'bun:test'
import { applyCdutToolGate, CDUT_TOOLS_GROUP_ID } from './agent-cdut-tools-gate'

describe('CDUT 工具组门控', () => {
  test('Given 显式开启 When 文本无教务词 Then 仍挂载 cdut-tools', () => {
    const groups = new Set<string>(['memory'])
    const result = applyCdutToolGate({ explicit: true, groups, text: '帮我总结这段代码' })
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('explicit')
    expect(groups.has(CDUT_TOOLS_GROUP_ID)).toBe(true)
  })

  test('Given 显式关闭 When 文本含成绩 Then 强制不挂载', () => {
    const groups = new Set<string>(['cdut-tools', 'memory'])
    const result = applyCdutToolGate({ explicit: false, groups, text: '帮我查一下成绩' })
    expect(result.enabled).toBe(false)
    expect(result.source).toBe('explicit')
    expect(groups.has(CDUT_TOOLS_GROUP_ID)).toBe(false)
  })

  test('Given 旧会话未设置 When 历史已激活 Then 继承激活状态', () => {
    const groups = new Set<string>(['cdut-tools'])
    const result = applyCdutToolGate({ groups, text: '今天天气怎么样' })
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('legacy-inherited')
  })

  test('Given 旧会话未设置 When 命中教务词 Then 正则兜底激活', () => {
    const groups = new Set<string>()
    const result = applyCdutToolGate({ groups, text: '帮我查一下绩点' })
    expect(result.enabled).toBe(true)
    expect(result.source).toBe('legacy-intent')
    expect(groups.has(CDUT_TOOLS_GROUP_ID)).toBe(true)
  })

  test('Given 预设禁用 When 显式开启 Then 预设一票否决', () => {
    const groups = new Set<string>()
    const result = applyCdutToolGate({
      explicit: true,
      groups,
      text: '帮我查成绩',
      disabled: ['cdut-tools'],
    })
    expect(result.enabled).toBe(false)
    expect(result.source).toBe('preset-disabled')
    expect(groups.has(CDUT_TOOLS_GROUP_ID)).toBe(false)
  })
})
