/**
 * 北京时间问候与时钟回归测试
 *
 * 锁死顽固 Bug：北京时间下午 17:43 曾被显示为「夜深了」。
 * 根因是 `Intl.DateTimeFormat('zh-CN', { hour: 'numeric' })` 输出「17时」，
 * `Number('17时')` 得到 NaN，所有时段区间比较全部落空并兜底为凌晨文案。
 */

import { describe, expect, it } from 'bun:test'
import {
  formatBeijingClock,
  getBeijingGreetingParts,
  getBeijingHour,
  greetingForBeijingHour,
} from '../src/renderer/lib/beijing-greeting'

/** 构造某个「北京时间」时刻（用 UTC 时刻精确表达，避免测试机时区干扰） */
function beijingInstant(hour: number, minute = 0): Date {
  // 北京时间 = UTC+8，故 UTC 小时 = 北京小时 - 8
  return new Date(Date.UTC(2026, 9, 16, hour - 8, minute, 0))
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
