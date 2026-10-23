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
 * 北京时间 HH:mm:ss 分解格式化器。
 * 通过 formatToParts 取纯数字，既不依赖本地化后缀，也避免每秒重建实例。
 */
const BEIJING_HMS_PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** 北京时间时分秒数字 */
export interface BeijingTimeNumbers {
  /** 0-23 */
  hour: number
  /** 0-59 */
  minute: number
  /** 0-59 */
  second: number
}

/** 北京时间表盘角度（0 <= angle < 360）与 HH:mm:ss 文本 */
export interface BeijingClockAngles extends BeijingTimeNumbers {
  /** 毫秒分量（0-999），用于锚点角度的毫秒级精度 */
  millisecond: number
  /** 时针角度：每小时 30°，每分钟 0.5°，每秒 1/120°，每毫秒 1/120000° */
  hourAngle: number
  /** 分针角度：每分钟 6°，每秒 0.1°，每毫秒 0.0001° */
  minuteAngle: number
  /** 秒针角度：每秒 6°（机械跳秒，不含毫秒） */
  secondAngle: number
  /** HH:mm:ss 文本 */
  clockText: string
}

/** 两位补零 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 从 formatToParts 结果中安全读取某一段的纯数字；缺失或非法时返回 null */
function readNumericPart(
  parts: Intl.DateTimeFormatPart[],
  type: 'hour' | 'minute' | 'second',
): number | null {
  const parsed = Number(parts.find((part) => part.type === type)?.value)
  return Number.isFinite(parsed) ? parsed : null
}

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

/**
 * 取得北京时间的时分秒纯数字（与宿主系统时区无关）。
 * 解析失败时兜底为 12:00:00，保证调用方永不拿到 NaN。
 */
export function getBeijingTimeNumbers(now: Date = new Date()): BeijingTimeNumbers {
  const parts = BEIJING_HMS_PARTS_FMT.formatToParts(now)
  const hour = readNumericPart(parts, 'hour')
  return {
    hour: hour === null ? 12 : ((hour % 24) + 24) % 24,
    minute: readNumericPart(parts, 'minute') ?? 0,
    second: readNumericPart(parts, 'second') ?? 0,
  }
}

/** 北京时间 HH:mm:ss 时钟文本（抽屉右上角时钟药丸消费） */
export function formatBeijingClock(now: Date = new Date()): string {
  const { hour, minute, second } = getBeijingTimeNumbers(now)
  return `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`
}

/**
 * 北京时间表盘指针角度。
 *
 * 角度公式精确联动：时针随分、秒、毫秒连续微动，分针随秒、毫秒连续微动，
 * 但秒针取整到 6° 的整数倍（1 秒 1 跳）。
 */
export function getBeijingClockAngles(now: Date = new Date()): BeijingClockAngles {
  const { hour, minute, second } = getBeijingTimeNumbers(now)
  const millisecond = now.getMilliseconds()
  return {
    hour,
    minute,
    second,
    millisecond,
    hourAngle: (hour % 12) * 30 + minute * 0.5 + second / 120 + millisecond / 120000,
    minuteAngle: minute * 6 + second * 0.1 + millisecond * 0.0001,
    secondAngle: second * 6,
    clockText: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
  }
}

/** 表盘时间锚点：挂载时刻与当时的周期角度 */
export interface BeijingClockAnchor {
  /** 锚点时刻（epoch 毫秒） */
  atMs: number
  /** 锚点时刻的周期角度 */
  angles: BeijingClockAngles
}

/** 连续旋转角度（单位：度，单调向前，不回转） */
export interface BeijingClockRotations {
  hourRotation: number
  minuteRotation: number
  secondRotation: number
}

/** 以当前时刻建立表盘锚点 */
export function createBeijingClockAnchor(now: Date = new Date()): BeijingClockAnchor {
  return { atMs: now.getTime(), angles: getBeijingClockAngles(now) }
}

/**
 * 从固定锚点纯推导连续旋转角度。
 *
 * 严禁改回「逐帧比较当前角度再做 360° 取模累加」：分/时针每秒仅移动 0.1°/0.0083°，
 * 浮点误差会让 `target - current` 出现极小负值，取模后得到约 359.999°，指针被判为
 * 「向前追一整圈」，叠加 CSS transition 便呈现整圈跳闪（历史 Bug）。
 *
 * 同一 `now` 多次调用结果完全一致，天然免疫 StrictMode 双调用与任意同帧重渲染。
 */
export function resolveBeijingClockRotations(
  anchor: BeijingClockAnchor,
  now: Date = new Date(),
): BeijingClockRotations {
  const elapsedMs = Math.max(0, now.getTime() - anchor.atMs)
  const elapsedSeconds = elapsedMs / 1000
  // 秒针按整秒跃迁，避免父级定时器的毫秒抖动污染机械跳秒
  const elapsedWholeSeconds = Math.max(
    0,
    Math.floor(now.getTime() / 1000) - Math.floor(anchor.atMs / 1000),
  )
  return {
    hourRotation: anchor.angles.hourAngle + elapsedSeconds * (360 / 43200),
    minuteRotation: anchor.angles.minuteAngle + elapsedSeconds * 0.1,
    secondRotation: anchor.angles.secondAngle + elapsedWholeSeconds * 6,
  }
}

/**
 * 是否需要重取表盘锚点。
 *
 * - 负向跳变：系统时间被 NTP/手动回拨，继续沿用旧锚点会让表盘假死；
 * - 超过 maxGapMs：休眠唤醒或后台节流恢复，沿用旧锚点会产生数千圈的角度过渡。
 */
export function shouldRebaseClockAnchor(
  lastTickMs: number,
  now: Date = new Date(),
  maxGapMs: number = 1500,
): boolean {
  const gapMs = now.getTime() - lastTickMs
  return gapMs < 0 || gapMs > maxGapMs
}
