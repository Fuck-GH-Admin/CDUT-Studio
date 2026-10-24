import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceNextRunAt, computeNextRunAt } from './automation-manager'

let configRoot = ''
beforeAll(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'automation-manager-'))
  process.env.PROFER_CONFIG_DIR = configRoot
})
afterAll(() => {
  try {
    rmSync(configRoot, { recursive: true, force: true })
  } catch {
    // Windows 下文件句柄可能延迟释放。
  }
})

describe('computeNextRunAt 月度调度', () => {
  // 用固定 from 时间戳避免测试与当前时间耦合
  const base = (y: number, m: number, d: number, hh: number, mm: number): number =>
    new Date(y, m - 1, d, hh, mm, 0, 0).getTime()

  test('Given 当月目标日还未到达 When 计算下次运行 Then 返回本月该日', () => {
    const from = base(2026, 6, 14, 9, 36)
    const next = computeNextRunAt(
      { scheduleType: 'monthly', timeOfDay: ['09:00'], dayOfMonth: [20] },
      from,
    )
    expect(new Date(next).getDate()).toBe(20)
    expect(new Date(next).getMonth() + 1).toBe(6)
  })

  test('Given 当月目标日已过 When 计算下次运行 Then 跳到下月同日', () => {
    const from = base(2026, 6, 14, 9, 36)
    const next = computeNextRunAt(
      { scheduleType: 'monthly', timeOfDay: ['09:00'], dayOfMonth: [10] },
      from,
    )
    expect(new Date(next).getMonth() + 1).toBe(7)
    expect(new Date(next).getDate()).toBe(10)
  })

  test('Given 3/31 目标 31 号已过 When 计算下次运行 Then 落在 4/30 而非跳到 5/1', () => {
    const from = base(2026, 3, 31, 9, 30)
    const next = computeNextRunAt(
      { scheduleType: 'monthly', timeOfDay: ['09:00'], dayOfMonth: [31] },
      from,
    )
    expect(new Date(next).getMonth() + 1).toBe(4)
    expect(new Date(next).getDate()).toBe(30)
  })

  test('Given 1/31 目标 31 号 When 计算下次运行 Then 落在 2/28 而非 3/3（关键：setDate(1) 防溢出）', () => {
    const from = base(2026, 1, 31, 9, 30)
    // 2026 年非闰年，2 月 28 天
    const next = computeNextRunAt(
      { scheduleType: 'monthly', timeOfDay: ['09:00'], dayOfMonth: [31] },
      from,
    )
    expect(new Date(next).getMonth() + 1).toBe(2)
    expect(new Date(next).getDate()).toBe(28)
  })

  test('Given 闰年 1/31 目标 31 号 When 计算下次运行 Then 落在 2/29', () => {
    const from = base(2024, 1, 31, 9, 30)
    const next = computeNextRunAt(
      { scheduleType: 'monthly', timeOfDay: ['09:00'], dayOfMonth: [31] },
      from,
    )
    expect(new Date(next).getMonth() + 1).toBe(2)
    expect(new Date(next).getDate()).toBe(29)
  })

  test('Given dayOfMonth=29 在 2 月 When 计算下次运行 Then 落在 2/28（平年）', () => {
    const from = base(2026, 1, 31, 9, 30)
    const next = computeNextRunAt(
      { scheduleType: 'monthly', timeOfDay: ['09:00'], dayOfMonth: [29] },
      from,
    )
    expect(new Date(next).getMonth() + 1).toBe(2)
    expect(new Date(next).getDate()).toBe(28)
  })
})

describe('computeNextRunAt 多值调度', () => {
  const base = (y: number, m: number, d: number, hh: number, mm: number): number =>
    new Date(y, m - 1, d, hh, mm, 0, 0).getTime()

  describe('daily 多时间', () => {
    test('多时间点，取今天最近的', () => {
      // 从 09:30 开始，timeOfDay=['09:00','14:00','20:00']，应选 14:00
      const from = base(2026, 6, 14, 9, 30)
      const next = computeNextRunAt(
        { scheduleType: 'daily', timeOfDay: ['09:00', '14:00', '20:00'] },
        from,
      )
      const d = new Date(next)
      expect(d.getHours()).toBe(14)
      expect(d.getMinutes()).toBe(0)
      expect(d.getDate()).toBe(14)
    })

    test('所有时间都已过，取明天第一个', () => {
      // 从 22:00 开始，所有时间都已过 → 明天 09:00
      const from = base(2026, 6, 14, 22, 0)
      const next = computeNextRunAt(
        { scheduleType: 'daily', timeOfDay: ['09:00', '14:00'] },
        from,
      )
      const d = new Date(next)
      expect(d.getDate()).toBe(15)
      expect(d.getHours()).toBe(9)
    })

    test('旧单值兼容：传入 string 也能工作', () => {
      const from = base(2026, 6, 14, 9, 30)
      const next = computeNextRunAt(
        { scheduleType: 'daily', timeOfDay: '09:00' as unknown as string[] },
        from,
      )
      const d = new Date(next)
      expect(d.getDate()).toBe(15)
      expect(d.getHours()).toBe(9)
    })
  })

  describe('weekly 多日多时间', () => {
    test('周一周三 09:00/14:00，选最近组合', () => {
      // 2026-06-14 是周日 (dow=0)，从 09:30 开始
      // 周一=1, 周三=3；timeOfDay=['09:00','14:00']
      // 最近：周一 (day=15) 09:00
      const from = base(2026, 6, 14, 9, 30) // 周日
      const next = computeNextRunAt(
        { scheduleType: 'weekly', dayOfWeek: [1, 3], timeOfDay: ['09:00', '14:00'] },
        from,
      )
      const d = new Date(next)
      expect(d.getDate()).toBe(15) // 周一
      expect(d.getHours()).toBe(9)
    })

    test('今天就是目标星期但时间已过，选下一个时间', () => {
      // 周一 14:30，目标周一 ['09:00','14:00']，09:00 已过 → 14:00 已过 → 下周一 09:00
      const from = base(2026, 6, 15, 14, 30) // 周一
      const next = computeNextRunAt(
        { scheduleType: 'weekly', dayOfWeek: [1], timeOfDay: ['09:00', '14:00'] },
        from,
      )
      const d = new Date(next)
      expect(d.getDate()).toBe(22) // 下周一
      expect(d.getHours()).toBe(9)
    })
  })

  describe('monthly 多日多时间', () => {
    test('每月 1 号和 15 号 09:00，取最近', () => {
      // 6/14 09:30，1 号已过 → 15 号 09:00
      const from = base(2026, 6, 14, 9, 30)
      const next = computeNextRunAt(
        { scheduleType: 'monthly', dayOfMonth: [1, 15], timeOfDay: ['09:00'] },
        from,
      )
      const d = new Date(next)
      expect(d.getDate()).toBe(15)
      expect(d.getHours()).toBe(9)
    })

    test('所有日期都已过，取下月第一个', () => {
      // 6/20 09:30，目标 [1, 15] 都已过 → 7/1 09:00
      const from = base(2026, 6, 20, 9, 30)
      const next = computeNextRunAt(
        { scheduleType: 'monthly', dayOfMonth: [1, 15], timeOfDay: ['09:00'] },
        from,
      )
      const d = new Date(next)
      expect(d.getMonth() + 1).toBe(7)
      expect(d.getDate()).toBe(1)
    })
  })
})

describe('interval 槽位对齐（消除累积漂移）', () => {
  const base = (y: number, m: number, d: number, hh: number, mm: number, ss = 0): number =>
    new Date(y, m - 1, d, hh, mm, ss, 0).getTime()

  test('Given 10:00 触发、10:00:47 完成 When 推进 Then 下一槽位仍是 10:05', () => {
    const slot = base(2026, 6, 14, 10, 0)
    const runAt = slot
    const now = base(2026, 6, 14, 10, 0, 47)
    const next = advanceNextRunAt(
      { scheduleType: 'interval', intervalMinutes: 5, nextRunAt: slot },
      runAt,
      now,
    )
    expect(new Date(next).getHours()).toBe(10)
    expect(new Date(next).getMinutes()).toBe(5)
    expect(new Date(next).getSeconds()).toBe(0)
  })

  test('Given 应用休眠跨过两个槽位 When 推进 Then 对齐到下一个未来槽位', () => {
    const slot = base(2026, 6, 14, 10, 0)
    const now = base(2026, 6, 14, 10, 16, 30)
    const next = advanceNextRunAt(
      { scheduleType: 'interval', intervalMinutes: 5, nextRunAt: slot },
      slot,
      now,
    )
    expect(new Date(next).getHours()).toBe(10)
    expect(new Date(next).getMinutes()).toBe(20)
    expect(new Date(next).getSeconds()).toBe(0)
  })
})

describe('appendRun 手动运行解耦', () => {
  test('Given 手动运行 When 记录 Then 不改变周期/次数/失败计数', async () => {
    const { createAutomation, appendRun, getAutomation } = await import('./automation-manager')
    const automation = createAutomation({
      name: '手动运行测试',
      prompt: 'hello',
      scheduleType: 'interval',
      intervalMinutes: 5,
      channelId: 'channel-1',
      workspaceId: 'workspace-1',
      active: true,
    })
    const before = getAutomation(automation.id)!
    appendRun(automation.id, {
      runAt: Date.now(),
      sessionId: 'session-x',
      status: 'success',
      durationMs: 10,
    }, { manual: true })
    const after = getAutomation(automation.id)!
    expect(after.nextRunAt).toBe(before.nextRunAt)
    expect(after.runCount).toBe(before.runCount)
    expect(after.lastRunAt).toBe(before.lastRunAt)
    expect(after.runHistory[0]?.status).toBe('success')
  })
})
