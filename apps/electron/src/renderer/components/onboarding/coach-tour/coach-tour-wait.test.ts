import { describe, expect, test } from 'bun:test'
import {
  agentWaitShouldCompleteByBaseline,
  petWaitShouldCompleteByBaseline,
  reduceAgentTurn,
} from './coach-tour-wait'

describe('reduceAgentTurn', () => {
  test('未观察到 running 时，idle 不得判定完成', () => {
    expect(reduceAgentTurn('awaiting-send', false, false)).toBe('awaiting-send')
  })

  test('观察到 running 后进入运行态', () => {
    expect(reduceAgentTurn('awaiting-send', true, false)).toBe('running')
  })

  test('running 回到 idle 且无后台任务时判定完成', () => {
    expect(reduceAgentTurn('running', false, false)).toBe('done')
  })

  test('后台任务仍在飞时不得判定完成', () => {
    expect(reduceAgentTurn('running', false, true)).toBe('running')
  })

  test('完成态保持稳定', () => {
    expect(reduceAgentTurn('done', true, false)).toBe('done')
  })
})

describe('agentWaitShouldCompleteByBaseline（快发快回兜底）', () => {
  const baseline = { startedAt: 1000, contentLen: 500 }

  test('启用前已发送且回合已更新（startedAt 前移）→ 判定完成', () => {
    expect(
      agentWaitShouldCompleteByBaseline(baseline, { startedAt: 2000, contentLen: 300 }),
    ).toBe(true)
  })

  test('同回合内容增长且已收敛 → 判定完成', () => {
    expect(
      agentWaitShouldCompleteByBaseline(baseline, { startedAt: 1000, contentLen: 800 }),
    ).toBe(true)
  })

  test('未发送（基线无变化）→ 不得误判', () => {
    expect(
      agentWaitShouldCompleteByBaseline(baseline, { startedAt: 1000, contentLen: 500 }),
    ).toBe(false)
  })

  test('缺失流式状态（新会话从未运行）→ 不得误判', () => {
    expect(agentWaitShouldCompleteByBaseline(baseline, {})).toBe(false)
  })

  test('回合更新但内容更短（新回复刚启动重置 content）→ 仍判定完成', () => {
    expect(
      agentWaitShouldCompleteByBaseline(baseline, { startedAt: 3000, contentLen: 10 }),
    ).toBe(true)
  })
})

describe('petWaitShouldCompleteByBaseline（桌宠快发快回兜底）', () => {
  test('出现晚于基线的完成时间 → 判定完成', () => {
    expect(petWaitShouldCompleteByBaseline(1000, 2000)).toBe(true)
  })

  test('完成时间与基线相同（未发送）→ 不得误判', () => {
    expect(petWaitShouldCompleteByBaseline(1000, 1000)).toBe(false)
  })

  test('从未完成（lastDoneAt 为 null）→ 不得误判', () => {
    expect(petWaitShouldCompleteByBaseline(1000, null)).toBe(false)
  })
})
