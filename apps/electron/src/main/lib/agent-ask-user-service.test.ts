import { describe, expect, test } from 'bun:test'
import { askUserService, normalizeAskUserQuestionType } from './agent-ask-user-service'

describe('AskUserQuestion 题型归一化', () => {
  test('显式合法 type 优先', () => {
    expect(normalizeAskUserQuestionType('single', 3, false)).toBe('single')
    expect(normalizeAskUserQuestionType('multiple', 3, false)).toBe('multiple')
    expect(normalizeAskUserQuestionType('fill-blank', 0, false)).toBe('fill-blank')
  })

  test('缺省 type 时按选项与 multiSelect 降级，兼容存量调用', () => {
    expect(normalizeAskUserQuestionType(undefined, 0, false)).toBe('fill-blank')
    expect(normalizeAskUserQuestionType(undefined, 3, true)).toBe('multiple')
    expect(normalizeAskUserQuestionType(undefined, 3, false)).toBe('single')
  })

  test('非法 type 不信任，仍走降级', () => {
    expect(normalizeAskUserQuestionType('essay', 3, true)).toBe('multiple')
    expect(normalizeAskUserQuestionType(42, 0, false)).toBe('fill-blank')
  })

  test('选择题缺 options 时降级为填空，避免下发无法作答的畸形题', () => {
    expect(normalizeAskUserQuestionType('single', 0, false)).toBe('fill-blank')
    expect(normalizeAskUserQuestionType('multiple', 0, true)).toBe('fill-blank')
  })
})

describe('AskUserQuestion 问答服务闭环（handleAskUserQuestion）', () => {
  test('given 平铺单题输入 when 解析 then 渲染层收到 1 道有效题', async () => {
    // 防模型幻觉：部分模型直接下发 { question, options } 而非 { questions: [...] }，必须兼容。
    const controller = new AbortController()
    let capturedQuestions: unknown
    const pending = askUserService.handleAskUserQuestion(
      'session-flat',
      { question: '选哪个方案？', options: [{ label: 'A' }, { label: 'B' }] },
      controller.signal,
      (request) => { capturedQuestions = request.questions },
    )

    expect(Array.isArray(capturedQuestions)).toBe(true)
    expect((capturedQuestions as unknown[])).toHaveLength(1)
    const first = (capturedQuestions as Array<{ question: string; options: Array<{ label: string }> }>)[0]!
    expect(first.question).toBe('选哪个方案？')
    expect(first.options.map((o) => o.label)).toEqual(['A', 'B'])

    // 清理：中止挂起请求，避免测试残留 pending。
    controller.abort()
    await pending
  })

  test('given 空题输入 when 处理 then 立即 deny 且不通知渲染层（防会话假死）', async () => {
    let notified = false
    const result = await askUserService.handleAskUserQuestion(
      'session-empty',
      {},
      new AbortController().signal,
      () => { notified = true },
    )

    expect(result.behavior).toBe('deny')
    expect(notified).toBe(false)
  })

  test('given 空 questions 数组 when 处理 then 同样熔断拒绝', async () => {
    const result = await askUserService.handleAskUserQuestion(
      'session-empty-array',
      { questions: [] },
      new AbortController().signal,
      () => {},
    )

    expect(result.behavior).toBe('deny')
  })
})
