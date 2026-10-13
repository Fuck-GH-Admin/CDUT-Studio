/**
 * 智联万站 · 关键事件审计日志（yanhu-event-log）单元测试
 *
 * 覆盖：单行格式契约（时间戳含时区偏移 / 类型 / 字段）、空值字段过滤、追加落盘与读取。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatYanhuEventLine, formatYanhuEventTime, logYanhuEvent } from './yanhu-event-log'

describe('formatYanhuEventTime（本地时间戳）', () => {
  test('包含毫秒与显式时区偏移', () => {
    const text = formatYanhuEventTime(new Date(2026, 9, 9, 16, 3, 38, 123))
    expect(text).toMatch(/^2026-10-09T16:03:38\.123[+-]\d{2}:\d{2}$/)
  })
})

describe('formatYanhuEventLine（单行事件格式）', () => {
  test('形如「时间戳 [类型] k=v」且过滤空值字段', () => {
    const line = formatYanhuEventLine(
      'reload',
      { tabId: 't1', url: 'https://xgfw.cdut.edu.cn/a', reason: 'self-heal-400', empty: '', nil: null, undef: undefined },
      new Date(2026, 9, 9, 16, 3, 38, 123),
    )
    expect(line).toContain('[reload]')
    expect(line).toContain('tabId=t1')
    expect(line).toContain('reason=self-heal-400')
    expect(line).not.toContain('empty=')
    expect(line).not.toContain('nil=')
    expect(line).not.toContain('undef=')
  })

  test('字段值内的换行被折叠为单行，避免日志被撑破', () => {
    const line = formatYanhuEventLine('load-url', { url: 'https://a\nb' })
    expect(line.split('\n')).toHaveLength(1)
  })
})

describe('logYanhuEvent（追加落盘）', () => {
  test('按追加方式写入并可按行读回', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'profer-yanhu-events-')), 'events.log')
    logYanhuEvent('tab-create', { tabId: 't1', url: 'https://a' }, file)
    logYanhuEvent('reload', { tabId: 't1', reason: 'tool' }, file)
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[tab-create]')
    expect(lines[1]).toContain('[reload]')
  })
})
