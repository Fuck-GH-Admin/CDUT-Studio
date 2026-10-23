/**
 * BDD 行为驱动测试：标准北京时间 / 教学周 / 24 小时课程雷达
 *
 * 全部使用内存合成数据（不依赖 `API Record/` 物理 fixture），
 * 并统一以显式 `+08:00` / `-04:00` 时刻构造，确保在任意宿主时区与 CI 环境 100% 稳定。
 */

import { describe, expect, it } from 'bun:test'
import {
  CDUT_SECTION_PERIODS,
  computeBeijingTeachingWeek,
  evaluateCourseLiveStatus,
  getBeijingTimeInfo,
  type LiveScheduleCourse,
} from './beijing-time'

/** 构造一门合成课程（weekList 空 = 全学期排课） */
function course(overrides: Partial<LiveScheduleCourse> = {}): LiveScheduleCourse {
  return {
    dayOfWeek: 1,
    startSection: 1,
    endSection: 2,
    weekList: [],
    ...overrides,
  }
}

describe('getBeijingTimeInfo（北京时间原子信息 BDD-BJTIME-01）', () => {
  it('Given 北京时间周六 22:00 When 提取 Then 星期/分钟/当日零点完全正确', () => {
    const info = getBeijingTimeInfo(new Date('2026-10-17T22:00:00+08:00'))
    expect(info.year).toBe(2026)
    expect(info.month).toBe(10)
    expect(info.day).toBe(17)
    expect(info.dayOfWeek).toBe(6)
    expect(info.hour).toBe(22)
    expect(info.minute).toBe(0)
    expect(info.minutesOfDay).toBe(22 * 60)
    expect(info.midnightMs).toBe(Date.parse('2026-10-17T00:00:00+08:00'))
  })

  it('Given 同一时刻用美东时间表达 When 提取 Then 结果与北京时间完全一致（宿主时区无关）', () => {
    const beijing = getBeijingTimeInfo(new Date('2026-10-17T22:00:00+08:00'))
    const eastern = getBeijingTimeInfo(new Date('2026-10-17T10:00:00-04:00'))
    expect(eastern).toEqual(beijing)
  })

  it('Given 北京时间午夜 00:00 When 提取 Then 小时为 0 且星期归属当天', () => {
    const info = getBeijingTimeInfo(new Date('2026-10-18T00:00:00+08:00'))
    expect(info.hour).toBe(0)
    expect(info.minutesOfDay).toBe(0)
    expect(info.dayOfWeek).toBe(7) // 周日
  })
})

describe('computeBeijingTeachingWeek（北京时间教学周 BDD-BJTIME-02）', () => {
  it('Given 秋学期首个周一 When 计算 Then 第 1 周', () => {
    expect(computeBeijingTeachingWeek(new Date('2026-08-31T09:00:00+08:00'))).toBe(1)
  })

  it('Given 秋学期第 7 个周一 When 计算 Then 第 7 周', () => {
    expect(computeBeijingTeachingWeek(new Date('2026-10-12T09:00:00+08:00'))).toBe(7)
  })

  it('Given 任意学期内时刻 When 计算 Then 始终夹取在 [1,25]', () => {
    for (const iso of ['2026-01-05T10:00:00+08:00', '2026-05-10T10:00:00+08:00', '2027-01-20T10:00:00+08:00']) {
      const week = computeBeijingTeachingWeek(new Date(iso))
      expect(week).toBeGreaterThanOrEqual(1)
      expect(week).toBeLessThanOrEqual(25)
    }
  })
})

describe('evaluateCourseLiveStatus（24 小时课程雷达 BDD-BJTIME-03）', () => {
  it('Given 作息表 When 读取 Then 与成都理工大学官方 11 节制作息锁定', () => {
    expect(CDUT_SECTION_PERIODS.length).toBe(6)
    expect(CDUT_SECTION_PERIODS[0]).toEqual({ startSection: 1, endSection: 2, startMin: 490, endMin: 585 })
    expect(CDUT_SECTION_PERIODS[5]).toEqual({ startSection: 11, endSection: 11, startMin: 1250, endMin: 1295 })
    for (const period of CDUT_SECTION_PERIODS) expect(period.endSection).toBeLessThanOrEqual(11)
  })

  it('Given 北京时间周一 09:00 When 评估 Then 命中 1-2 节课程为 ongoing 且 next 为 null', () => {
    const courses = [course({ dayOfWeek: 1 }), course({ dayOfWeek: 2 })]
    const status = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-08-31T09:00:00+08:00')))
    expect(status.ongoing).toBe(status.markedCourses[0]!)
    expect(status.ongoing?.dayOfWeek).toBe(1)
    expect(status.next).toBeNull()
    expect(status.markedCourses.filter((c) => c.isOngoing).length).toBe(1)
  })

  it('Given 同一时段两门课重叠 When 评估 Then 全部标记 isOngoing 且雷达取首门', () => {
    const courses = [course({ dayOfWeek: 1 }), course({ dayOfWeek: 1 })]
    const status = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-08-31T09:00:00+08:00')))
    expect(status.markedCourses.filter((c) => c.isOngoing).length).toBe(2)
    expect(status.ongoing).toBe(status.markedCourses[0]!)
  })

  it('Given 9-11 节连排实验课 When 北京时间 21:00 评估 Then 跨越多个作息区间仍判为 ongoing', () => {
    const courses = [course({ dayOfWeek: 1, startSection: 9, endSection: 11 })]
    const status = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-08-31T21:00:00+08:00')))
    expect(status.ongoing).toBe(status.markedCourses[0]!)
  })

  it('Given 北京时间周六 22:00 When 评估 Then 周日课为 next，34 小时外的周一课被排除', () => {
    const courses = [
      course({ dayOfWeek: 7, startSection: 9, endSection: 10 }),
      course({ dayOfWeek: 1 }),
    ]
    const status = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-10-17T22:00:00+08:00')))
    expect(status.ongoing).toBeNull()
    expect(status.next?.dayOfWeek).toBe(7)
    expect(status.markedCourses.filter((c) => c.isNext).length).toBe(1)
  })

  it('Given 未来 24 小时无课程 When 评估 Then next 为 null（绝不展示数天后课程）', () => {
    const courses = [course({ dayOfWeek: 1 })]
    const status = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-10-17T22:00:00+08:00')))
    expect(status.next).toBeNull()
    expect(status.ongoing).toBeNull()
  })

  it('Given 课程携带陈旧静态标记 When 评估 Then 标记被重置且原数组不被修改', () => {
    const stale = course({ dayOfWeek: 4, isOngoing: true, isNext: true })
    const courses = [stale]
    const status = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-08-31T09:00:00+08:00')))
    expect(stale.isOngoing).toBe(true) // 原对象保持原样
    expect(status.markedCourses[0]!.isOngoing).toBe(false)
    expect(status.markedCourses[0]!.isNext).toBe(false)
  })

  it('Given 课程周单不包含当前教学周 When 评估 Then 不误判为 ongoing', () => {
    const courses = [course({ dayOfWeek: 1, weekList: [7] })]
    const status = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-08-31T09:00:00+08:00')))
    expect(status.ongoing).toBeNull()
  })

  it('Given 美东时区下同一绝对时刻 When 评估 Then 与北京时间口径完全一致', () => {
    const courses = [course({ dayOfWeek: 1 })]
    const beijing = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-08-31T09:00:00+08:00')))
    const eastern = evaluateCourseLiveStatus(courses, getBeijingTimeInfo(new Date('2026-08-30T21:00:00-04:00')))
    expect(eastern.ongoing).not.toBeNull()
    expect(eastern.ongoing?.dayOfWeek).toBe(beijing.ongoing?.dayOfWeek)
  })
})
