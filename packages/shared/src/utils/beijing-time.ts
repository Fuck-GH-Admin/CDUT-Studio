/**
 * 标准北京时间 + CDUT 教学作息与实时课程雷达（主进程 / 渲染进程同构纯函数）
 *
 * 背景（顽固 Bug 根因）：
 *   - 此前课表雷达使用宿主 `getDay()/getHours()/getMinutes()/setHours(0,0,0,0)`，
 *     海外时区或夏令时下会把北京晚间误判为上午早课，导致「正在上课 / 下节课」完全错乱；
 *   - 雷达状态又是在请求瞬间写死的静态布尔值，抽屉长期打开时永不随时间推进。
 *
 * 因此这里以 `Intl.DateTimeFormat(Asia/Shanghai)` 固化北京时间，并把
 * 「教学周 + 节次时段 + 24 小时滑动窗口」收敛为与宿主时区无关的纯函数，
 * 供主进程与渲染进程共用（渲染层按分钟重算即可自动到点切课）。
 */

/** 一天的毫秒数 */
const DAY_MS = 86_400_000
/** 24 小时雷达滑动窗口 */
const WINDOW_MS = 24 * 3_600_000
/** 北京时间相对 UTC 的固定偏移（Asia/Shanghai 无夏令时） */
const BEIJING_OFFSET_MS = 8 * 3_600_000

/** 北京时间原子信息（全部为北京日历数值，与宿主时区无关） */
export interface BeijingTimeInfo {
  year: number
  /** 1-12 */
  month: number
  day: number
  /** 1=周一 … 7=周日 */
  dayOfWeek: number
  hour: number
  minute: number
  second: number
  /** 当日累计分钟数（hour * 60 + minute） */
  minutesOfDay: number
  /** 北京时间当日 00:00 对应的绝对毫秒戳 */
  midnightMs: number
  /** 传入时刻的绝对毫秒戳（24 小时窗口计算用） */
  epochMs: number
}

/** CDUT 单段作息（当日起始/结束分钟） */
export interface CdutSectionPeriod {
  startSection: number
  endSection: number
  /** 当日起始分钟（如 08:10 → 490） */
  startMin: number
  /** 当日结束分钟（如 09:45 → 585） */
  endMin: number
}

/** 实时雷达可识别的课程最小结构（个人课表与演示数据共用） */
export interface LiveScheduleCourse {
  dayOfWeek: number
  startSection: number
  endSection: number
  /** 通用周次展开列表（空数组 = 全学期排课） */
  weekList: number[]
  isOngoing?: boolean
  isNext?: boolean
}

/** 实时雷达评估结果 */
export interface CourseLiveStatus<T extends LiveScheduleCourse> {
  /** 正在上课的课程（无则为 null） */
  ongoing: T | null
  /** 未来 24 小时内最早开课且尚未开课的课程（无则为 null） */
  next: T | null
  /** 全量浅拷贝并重置/重算 isOngoing、isNext 后的课程数组（不修改入参） */
  markedCourses: T[]
}

/**
 * 成都理工大学官方作息表（11 节制契约，严禁出现第 12 节课）。
 * 每节课 45 分钟、节间休息 5 分钟；第 11 节为单节（全校最晚时段 20:50-21:35）。
 */
export const CDUT_SECTION_PERIODS: ReadonlyArray<CdutSectionPeriod> = [
  { startSection: 1, endSection: 2, startMin: 8 * 60 + 10, endMin: 9 * 60 + 45 }, // 08:10-09:45
  { startSection: 3, endSection: 4, startMin: 10 * 60 + 15, endMin: 11 * 60 + 50 }, // 10:15-11:50
  { startSection: 5, endSection: 6, startMin: 14 * 60 + 30, endMin: 16 * 60 + 5 }, // 14:30-16:05
  { startSection: 7, endSection: 8, startMin: 16 * 60 + 25, endMin: 18 * 60 }, // 16:25-18:00
  { startSection: 9, endSection: 10, startMin: 19 * 60 + 10, endMin: 20 * 60 + 45 }, // 19:10-20:45
  { startSection: 11, endSection: 11, startMin: 20 * 60 + 50, endMin: 21 * 60 + 35 }, // 20:50-21:35
]

/** 北京时间日历字段格式化器（en-GB + h23 恒为纯数字，绝不出现「17时」） */
const BEIJING_PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** 提取北京时间的年月日时分秒、星期与当日累计分钟 */
export function getBeijingTimeInfo(now: Date = new Date()): BeijingTimeInfo {
  const parts = BEIJING_PARTS_FMT.formatToParts(now)
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value ?? ''
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : 0
  }

  const year = pick('year')
  const month = pick('month')
  const day = pick('day')
  const hour = pick('hour')
  const minute = pick('minute')
  const second = pick('second')
  // 星期通过北京日历日的 UTC 星期反推，彻底避开宿主本地时区
  const utcDow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const dayOfWeek = utcDow === 0 ? 7 : utcDow

  return {
    year,
    month,
    day,
    dayOfWeek,
    hour,
    minute,
    second,
    minutesOfDay: hour * 60 + minute,
    midnightMs: Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS,
    epochMs: now.getTime(),
  }
}

/**
 * 依据北京时间估算教学周次：以「秋学期 9 月首个周一 / 春学期 3 月首个周一」为第 1 周起点，
 * 周次夹取至 [1, 25]。纯启发式（不与任何特定学期日期硬编码耦合）。
 */
function teachingWeekFromInfo(info: BeijingTimeInfo): number {
  const isAutumn = info.month >= 7 || info.month <= 1
  const startYear = info.month <= 1 ? info.year - 1 : info.year
  // 秋学期起点 9 月（0-indexed 8），春学期起点 3 月（0-indexed 2）
  const firstOfMonthUtc = Date.UTC(startYear, isAutumn ? 8 : 2, 1)
  const firstDow = new Date(firstOfMonthUtc).getUTCDay()
  // 统一到「北京时间零点」尺度，避免与 UTC 零点混算造成整周偏移
  const mondayMs = firstOfMonthUtc - ((firstDow === 0 ? 7 : firstDow) - 1) * DAY_MS - BEIJING_OFFSET_MS
  const week = Math.floor((info.midnightMs - mondayMs) / (7 * DAY_MS)) + 1
  return Math.max(1, Math.min(25, week))
}

/** 严格按北京时间计算当前教学周（1-25） */
export function computeBeijingTeachingWeek(now: Date = new Date()): number {
  return teachingWeekFromInfo(getBeijingTimeInfo(now))
}

/** 课程节次映射到当日分钟区间（跨大节取最早开始与最晚结束，兼容 3 小节连排） */
function sectionRangeFor(course: LiveScheduleCourse): { start: number; end: number } | null {
  let start = Number.MAX_SAFE_INTEGER
  let end = -1
  for (const period of CDUT_SECTION_PERIODS) {
    if (course.startSection <= period.endSection && course.endSection >= period.startSection) {
      start = Math.min(start, period.startMin)
      end = Math.max(end, period.endMin)
    }
  }
  return end >= 0 ? { start, end } : null
}

/**
 * 实时课程雷达（24 小时精准窗口版）：结合北京时间标记 isOngoing / isNext。
 *   - isOngoing：本周次、今天、且课程节次区间包含当前分钟（正在上课）；
 *   - isNext：未来 24 小时内最早开课且尚未开课的一门课（周日夜间自动衔接下周次）；
 *     严格限定 courseStartMs - nowMs <= 24h，窗口外不标记任何「下节课」。
 * 纯函数：不修改入参数组，返回带全新标记的浅拷贝数组。
 */
export function evaluateCourseLiveStatus<T extends LiveScheduleCourse>(
  courses: T[],
  info: BeijingTimeInfo = getBeijingTimeInfo(),
): CourseLiveStatus<T> {
  const currentWeek = teachingWeekFromInfo(info)

  /** 课程是否在指定教学周排课（weekList 为空视为全学期排课） */
  const scheduledInWeek = (course: T, week: number): boolean =>
    course.weekList.length === 0 || course.weekList.includes(week)

  // 正在上课判定：本周次 + 今天 + 时刻落在课程时段内（同一时段多门课全部标记）
  const ongoingFlags = courses.map(() => false)
  let ongoingIdx = -1
  for (let index = 0; index < courses.length; index++) {
    const course = courses[index]!
    if (course.dayOfWeek !== info.dayOfWeek || !scheduledInWeek(course, currentWeek)) continue
    const range = sectionRangeFor(course)
    if (range && info.minutesOfDay >= range.start && info.minutesOfDay <= range.end) {
      ongoingFlags[index] = true
      if (ongoingIdx === -1) ongoingIdx = index
    }
  }

  // 下节课判定：未来 24 小时内最早开课的一门（跨周自动衔接下周周单）
  let nextIdx = -1
  if (ongoingIdx === -1) {
    let bestStartMs = Number.POSITIVE_INFINITY
    for (let index = 0; index < courses.length; index++) {
      const course = courses[index]!
      const range = sectionRangeFor(course)
      if (!range) continue
      const dist = (course.dayOfWeek - info.dayOfWeek + 7) % 7 // 0 = 今天，1-6 = 本周后续 / 下周同日
      const weekOffset = Math.floor((info.dayOfWeek - 1 + dist) / 7) // 周日夜间跨周时周次 +1
      if (!scheduledInWeek(course, currentWeek + weekOffset)) continue
      const startMs = info.midnightMs + dist * DAY_MS + range.start * 60_000
      const delta = startMs - info.epochMs
      // 必须严格在未来且不超过 24 小时；今天已开课/已结束的时段顺延下周后自然超出窗口被排除
      if (delta <= 0 || delta > WINDOW_MS) continue
      if (startMs < bestStartMs) {
        bestStartMs = startMs
        nextIdx = index
      }
    }
  }

  const markedCourses = courses.map((course, index) => ({
    ...course,
    isOngoing: ongoingFlags[index] === true,
    isNext: index === nextIdx,
  }))

  return {
    ongoing: ongoingIdx >= 0 ? markedCourses[ongoingIdx]! : null,
    next: nextIdx >= 0 ? markedCourses[nextIdx]! : null,
    markedCourses,
  }
}
