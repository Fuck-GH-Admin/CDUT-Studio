/**
 * 北京时间问候与时钟回归测试
 *
 * 锁死顽固 Bug：北京时间下午 17:43 曾被显示为「夜深了」。
 * 根因是 `Intl.DateTimeFormat('zh-CN', { hour: 'numeric' })` 输出「17时」，
 * `Number('17时')` 得到 NaN，所有时段区间比较全部落空并兜底为凌晨文案。
 */

import { describe, expect, it } from 'bun:test'
import {
  createBeijingClockAnchor,
  formatBeijingClock,
  getBeijingClockAngles,
  getBeijingGreetingParts,
  getBeijingHour,
  getBeijingTimeNumbers,
  greetingForBeijingHour,
  resolveBeijingClockRotations,
  shouldRebaseClockAnchor,
} from '../src/renderer/lib/beijing-greeting'

/** 构造某个「北京时间」时刻（用 UTC 时刻精确表达，避免测试机时区干扰） */
function beijingInstant(hour: number, minute = 0): Date {
  // 北京时间 = UTC+8，故 UTC 小时 = 北京小时 - 8
  return new Date(Date.UTC(2026, 9, 16, hour - 8, minute, 0))
}

/** 同上，但精确到秒（表盘角度用例需要） */
function beijingInstantHms(hour: number, minute = 0, second = 0): Date {
  return new Date(Date.UTC(2026, 9, 16, hour - 8, minute, second))
}

describe('getBeijingHour（北京时间小时解析 BDD-GREETING-01）', () => {
  it('Given 北京时间 17:43 When 取小时 Then 返回 17（绝不为 NaN）', () => {
    const hour = getBeijingHour(beijingInstant(17, 43))
    expect(Number.isFinite(hour)).toBe(true)
    expect(hour).toBe(17)
  })

  it('Given 全天 24 个整点 When 取小时 Then 与北京小时逐一相等', () => {
    for (let h = 0; h < 24; h++) {
      expect(getBeijingHour(beijingInstant(h))).toBe(h)
    }
  })

  it('Given 北京时间午夜 00:00 When 取小时 Then 返回 0 而非 24', () => {
    expect(getBeijingHour(beijingInstant(0))).toBe(0)
  })
})

describe('getBeijingGreetingParts（问候语分时段 BDD-GREETING-02）', () => {
  it('Given 北京时间 17:43 When 生成问候 Then 明确为下午问候，绝非「夜深了」', () => {
    const { greeting, hour, timeText } = getBeijingGreetingParts(beijingInstant(17, 43))
    expect(hour).toBe(17)
    expect(greeting).toContain('下午好')
    expect(greeting).not.toContain('夜深了')
    expect(timeText).toBe('17:43')
  })

  it('Given 各时段整点 When 生成问候 Then 分别命中早上/中午/下午/晚上/深夜', () => {
    expect(greetingForBeijingHour(6)).toContain('早上好')
    expect(greetingForBeijingHour(12)).toContain('中午好')
    expect(greetingForBeijingHour(15)).toContain('下午好')
    expect(greetingForBeijingHour(20)).toContain('晚上好')
    expect(greetingForBeijingHour(2)).toContain('夜深了')
  })

  it('Given 时段边界 When 生成问候 Then 区间归属明确（05/12/14/18 为切换点）', () => {
    expect(greetingForBeijingHour(5)).toContain('早上好')
    expect(greetingForBeijingHour(11)).toContain('早上好')
    expect(greetingForBeijingHour(13)).toContain('中午好')
    expect(greetingForBeijingHour(18)).toContain('晚上好')
    expect(greetingForBeijingHour(23)).toContain('晚上好')
    expect(greetingForBeijingHour(0)).toContain('夜深了')
    expect(greetingForBeijingHour(4)).toContain('夜深了')
  })
})

describe('formatBeijingClock（抽屉北京时间时钟 BDD-GREETING-03）', () => {
  it('Given 北京时间 17:43:05 When 格式化 Then 输出 HH:mm:ss 纯数字时钟', () => {
    expect(formatBeijingClock(beijingInstant(17, 43))).toMatch(/^17:43:\d{2}$/)
  })

  it('Given 全天 24 个整点 When 格式化 Then 均无「时/分」等本地化后缀', () => {
    for (let h = 0; h < 24; h++) {
      const text = formatBeijingClock(beijingInstant(h))
      expect(text).not.toContain('时')
      expect(text).not.toContain('分')
      expect(text).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    }
  })
})

describe('getBeijingClockAngles（表盘指针角度 BDD-GREETING-04）', () => {
  it('Given 北京时间 10:04:18 When 计算角度 Then 时分秒角度精确联动', () => {
    const angles = getBeijingClockAngles(beijingInstantHms(10, 4, 18))
    expect(angles.hour).toBe(10)
    expect(angles.minute).toBe(4)
    expect(angles.second).toBe(18)
    // 时针：10*30 + 4*0.5 + 18/120 = 302.15
    expect(angles.hourAngle).toBeCloseTo(302.15, 5)
    // 分针：4*6 + 18*0.1 = 25.8
    expect(angles.minuteAngle).toBeCloseTo(25.8, 5)
    // 秒针：18*6 = 108
    expect(angles.secondAngle).toBe(108)
    expect(angles.clockText).toBe('10:04:18')
  })

  it('Given 00:00:00 与 12:00:00 When 计算角度 Then 时针均归零到 12 点方向', () => {
    for (const hour of [0, 12]) {
      const angles = getBeijingClockAngles(beijingInstantHms(hour, 0, 0))
      expect(angles.hourAngle).toBe(0)
      expect(angles.minuteAngle).toBe(0)
      expect(angles.secondAngle).toBe(0)
      expect(angles.clockText).toBe(`${String(hour).padStart(2, '0')}:00:00`)
    }
  })

  it('Given 北京时间 23:59:59 When 计算角度 Then 时针仍在 0~360 区间内', () => {
    const { hourAngle } = getBeijingClockAngles(beijingInstantHms(23, 59, 59))
    expect(hourAngle).toBeGreaterThan(0)
    expect(hourAngle).toBeLessThan(360)
  })

  it('Given 遍历全天整点与第 59 秒 When 计算角度 Then 三个角度均有限且落在 0~360', () => {
    for (let h = 0; h < 24; h++) {
      for (const second of [0, 59]) {
        const angles = getBeijingClockAngles(beijingInstantHms(h, 30, second))
        for (const angle of [angles.hourAngle, angles.minuteAngle, angles.secondAngle]) {
          expect(Number.isFinite(angle)).toBe(true)
          expect(angle).toBeGreaterThanOrEqual(0)
          expect(angle).toBeLessThan(360)
        }
        expect(angles.clockText).toMatch(/^\d{2}:\d{2}:\d{2}$/)
      }
    }
  })
})

describe('getBeijingClockAngles 时区隔离（BDD-GREETING-05）', () => {
  it('Given UTC 2026-10-16T00:30:45Z When 计算 Then 北京时间为 08:30:45，与测试机时区无关', () => {
    const numbers = getBeijingTimeNumbers(new Date('2026-10-16T00:30:45Z'))
    expect(numbers).toEqual({ hour: 8, minute: 30, second: 45 })

    const angles = getBeijingClockAngles(new Date('2026-10-16T00:30:45Z'))
    expect(angles.secondAngle).toBe(270)
    expect(angles.minuteAngle).toBeCloseTo(184.5, 5)
    expect(angles.hourAngle).toBeCloseTo(255.375, 5)
    expect(angles.clockText).toBe('08:30:45')
  })

  it('Given UTC 2026-10-15T17:00:00Z（北京时间已跨日）When 计算 Then 归入次日 01:00', () => {
    const angles = getBeijingClockAngles(new Date('2026-10-15T17:00:00Z'))
    expect(angles.hour).toBe(1)
    expect(angles.minute).toBe(0)
    expect(angles.minuteAngle).toBe(0)
    expect(angles.clockText).toBe('01:00:00')
  })
})

describe('resolveBeijingClockRotations（表盘锚点连续推导 BDD-GREETING-06）', () => {
  it('Given 同一 now 连续解析两次 When 对比 Then 三个旋转角完全一致（同帧重渲染不得整圈跳变）', () => {
    const anchor = createBeijingClockAnchor(beijingInstantHms(10, 4, 18))
    const now = beijingInstantHms(10, 4, 19)
    expect(resolveBeijingClockRotations(anchor, now)).toEqual(
      resolveBeijingClockRotations(anchor, now),
    )
  })

  it('Given 锚点 10:04:18.700 When 1 秒后 Then 秒针 +6°、分针 +0.1°、时针 +1/120°', () => {
    const anchor = createBeijingClockAnchor(new Date(Date.UTC(2026, 9, 16, 2, 4, 18, 700)))
    const now = new Date(Date.UTC(2026, 9, 16, 2, 4, 19, 700))
    const rotations = resolveBeijingClockRotations(anchor, now)

    expect(rotations.secondRotation - anchor.angles.secondAngle).toBe(6)
    expect(rotations.minuteRotation - anchor.angles.minuteAngle).toBeCloseTo(0.1, 10)
    expect(rotations.hourRotation - anchor.angles.hourAngle).toBeCloseTo(1 / 120, 10)
  })

  it('Given 北京时间 23:59:59 When 跨到次日 00:00:00 Then 秒针 354° → 360°，绝不回退到 0°', () => {
    const anchor = createBeijingClockAnchor(beijingInstantHms(23, 59, 59))
    const rotations = resolveBeijingClockRotations(anchor, new Date(anchor.atMs + 1000))

    expect(anchor.angles.secondAngle).toBe(354)
    expect(rotations.secondRotation).toBe(360)
  })

  it('Given 跨 1 小时 When 解析 Then 时针 +30°、分针 +360°、秒针 +21600°（连续不回绕）', () => {
    const anchor = createBeijingClockAnchor(beijingInstantHms(10, 0, 0))
    const rotations = resolveBeijingClockRotations(anchor, beijingInstantHms(11, 0, 0))

    expect(rotations.hourRotation - anchor.angles.hourAngle).toBeCloseTo(30, 10)
    expect(rotations.minuteRotation - anchor.angles.minuteAngle).toBeCloseTo(360, 10)
    expect(rotations.secondRotation - anchor.angles.secondAngle).toBe(21600)
  })

  it('Given 锚点含毫秒 When 计算角度 Then 毫秒项参与时/分针角度', () => {
    const angles = getBeijingClockAngles(new Date(Date.UTC(2026, 9, 16, 2, 4, 18, 500)))

    expect(angles.millisecond).toBe(500)
    expect(angles.minuteAngle).toBeCloseTo(25.85, 10)
    expect(angles.hourAngle).toBeCloseTo(302.1541666667, 6)
  })
})

describe('shouldRebaseClockAnchor（休眠唤醒/时间回拨重锚 BDD-GREETING-07）', () => {
  const baseMs = new Date('2026-10-16T02:04:18.000Z').getTime()

  it('Given 正常 1 秒 tick 或 1.4 秒迟到 When 判定 Then 无需重锚', () => {
    expect(shouldRebaseClockAnchor(baseMs, new Date(baseMs + 1000))).toBe(false)
    expect(shouldRebaseClockAnchor(baseMs, new Date(baseMs + 1400))).toBe(false)
  })

  it('Given 休眠 8 小时或系统时间回拨 When 判定 Then 必须重锚', () => {
    expect(shouldRebaseClockAnchor(baseMs, new Date(baseMs + 8 * 3600_000))).toBe(true)
    expect(shouldRebaseClockAnchor(baseMs, new Date(baseMs - 1000))).toBe(true)
  })
})
