/**
 * 北京时间问候与时钟（纯函数模块，无 DOM / React 依赖）
 *
 * 抽出为独立模块的原因：该逻辑曾被「zh-CN + hour: 'numeric' 返回『17时』」的取值陷阱击穿，
 * 导致北京时间下午 17:43 被判成凌晨并显示「夜深了」。此处以纯函数固化，并配单元测试锁死回归。
 */

/** 北京时间分时段问候 */
export interface BeijingGreetingParts {
  /** 完整的问候语（含时段描述） */
  greeting: string
  /** 北京时间小时数（0-23，已归一化；解析失败时退化为 12） */
  hour: number
  /** HH:mm 形式的北京时间文本 */
  timeText: string
}

/** 纯数字小时格式化器（en-GB + h23 恒输出 "00"-"23"，绝无「时」等本地化后缀） */
const BEIJING_HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  hourCycle: 'h23',
})

/** 北京时间 HH:mm 格式化器 */
const BEIJING_TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
})

/**
 * 取得北京时间的纯数字小时（0-23）。
 *
 * 严禁使用 `Intl.DateTimeFormat('zh-CN', { hour: 'numeric' })` —— 该组合输出「17时」，
 * `Number('17时')` 得到 NaN，所有时段比较全部落空并兜底为「夜深了」。
 */
export function getBeijingHour(now: Date = new Date()): number {
  const parsed = Number(BEIJING_HOUR_FMT.format(now))
  return Number.isFinite(parsed) ? ((parsed % 24) + 24) % 24 : 12
}

/** 依据北京时间小时数给出分时段问候语 */
export function greetingForBeijingHour(hour: number): string {
  if (hour >= 5 && hour < 12) return '早上好，开启专注充实的一天'
  if (hour >= 12 && hour < 14) return '中午好，午间小憩，灵感不打烊'
  if (hour >= 14 && hour < 18) return '下午好，继续推进手头的项目吧'
  if (hour >= 18 && hour < 24) return '晚上好，今日收获如何？'
  return '夜深了，注意休息哦'
}

/** 北京时间问候 + 时钟（与宿主时区无关，始终以 Asia/Shanghai 为准） */
export function getBeijingGreetingParts(now: Date = new Date()): BeijingGreetingParts {
  const hour = getBeijingHour(now)
  return {
    greeting: greetingForBeijingHour(hour),
    hour,
    timeText: BEIJING_TIME_FMT.format(now),
  }
}

/** 北京时间 HH:mm:ss 时钟文本（抽屉右上角时钟药丸消费） */
export function formatBeijingClock(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(now)
  return parts
}
