import { describe, expect, test } from 'bun:test'
import {
  classifyAutomationFailure,
  isAgentBusyError,
  shouldRecordBusySkip,
} from './automation-run-guard'

describe('定时任务错误分类', () => {
  test('Given AGENT_RUN_ALREADY_ACTIVE When 分类 Then 归为 skipped 且不进入熔断', () => {
    const classified = classifyAutomationFailure(
      new Error('AGENT_RUN_ALREADY_ACTIVE: 上一条消息仍在处理中，请稍候再试'),
    )
    expect(classified.status).toBe('skipped')
    expect(classified.reason).toContain('正在与用户交互')
  })

  test('Given 普通执行异常 When 分类 Then 归为 error', () => {
    const classified = classifyAutomationFailure(new Error('模型请求超时'))
    expect(classified.status).toBe('error')
    expect(classified.reason).toBe('模型请求超时')
  })

  test('Given 非 Error 值 When 判断忙碌 Then false', () => {
    expect(isAgentBusyError(undefined)).toBe(false)
    expect(isAgentBusyError('普通错误')).toBe(false)
  })
})

describe('目标会话忙碌跳过写历史节流', () => {
  test('Given 首次忙碌 When 判断 Then 记录一条', () => {
    expect(shouldRecordBusySkip(undefined, 1_000)).toBe(true)
  })

  test('Given 5 分钟内再次忙碌 When 判断 Then 不重复记录', () => {
    const first = 1_000
    expect(shouldRecordBusySkip(first, first + 30_000)).toBe(false)
    expect(shouldRecordBusySkip(first, first + 5 * 60_000)).toBe(true)
  })
})
