/**
 * 智联万站 · 关键事件审计日志（YanhuEventLog）
 *
 * 背景：此前「页面白屏 / 意外跳转」这类事故**完全无痕**——只能靠 155MB 的 NetLog 反推，
 * 且无法区分「工具发起」「400 自愈」「页面自身」三类触发源。
 *
 * 本模块把会改变页面状态的关键事件以追加方式落盘 `~/.cdutai/yanhu-express/events.log`
 * （单行一条，含本地时间戳、事件类型、标签、URL 与来源原因），供事故复盘精确定位。
 *
 * 边界声明：纯旁路日志，**任何异常一律静默吞掉**，绝不干扰浏览器主链路；文件超过上限自动滚动。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { YANHU_EVENTS_LOG_MAX_BYTES, getYanhuEventsLogPath } from './yanhu-constants'

/** 事件类型 */
export type YanhuEventKind =
  | 'load-url'
  | 'will-navigate'
  | 'did-navigate'
  | 'did-navigate-in-page'
  | 'reload'
  | 'ticket-sanitize'
  | 'self-heal-400'
  | 'tab-create'
  | 'tab-close'
  | 'blocked'
  | 'restore-fallback'
  | 'cert-blocked'
  | 'cert-allow'
  | 'cert-back'

/** 单条事件的附加字段（值一律转为字符串，避免对象序列化噪音） */
export type YanhuEventDetail = Record<string, string | number | boolean | null | undefined>

/** 本地时间戳（含东八区偏移），形如 2026-10-09T16:03:38.123+08:00 */
export function formatYanhuEventTime(date: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * 纯函数：格式化单行事件文本（便于单测断言格式）。
 */
export function formatYanhuEventLine(
  kind: YanhuEventKind,
  detail: YanhuEventDetail = {},
  date: Date = new Date(),
): string {
  const fields: string[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined || value === null || value === '') continue
    const text = String(value).replace(/\s+/g, ' ')
    fields.push(`${key}=${text}`)
  }
  return `${formatYanhuEventTime(date)} [${kind}] ${fields.join(' ')}`.trimEnd()
}

/** 超过体积上限时滚动为 events.log.1（覆盖旧备份），避免无界增长 */
function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    if (statSync(filePath).size <= YANHU_EVENTS_LOG_MAX_BYTES) return
    renameSync(filePath, `${filePath}.1`)
  } catch {
    // 忽略滚动失败：宁可继续追加也不阻断
  }
}

/**
 * 追加一条事件日志。
 *
 * @param kind 事件类型
 * @param detail 附加字段（tabId / url / reason 等）
 * @param filePath 覆盖写入路径（仅供单测注入；生产使用默认路径）
 */
export function logYanhuEvent(
  kind: YanhuEventKind,
  detail: YanhuEventDetail = {},
  filePath: string = getYanhuEventsLogPath(),
): void {
  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateIfNeeded(filePath)
    appendFileSync(filePath, `${formatYanhuEventLine(kind, detail)}\n`, 'utf8')
  } catch {
    // 纯旁路日志，任何异常静默吞掉
  }
}
