/**
 * installer-downloader 断点续传纯函数测试
 *
 * 覆盖：Range 头构造（无 .part 不传 / 有 .part 传 bytes=N-）、
 * 206 Content-Range 解析（起点 / 总长）、416 识别。
 */
import { describe, expect, test } from 'bun:test'

import {
  buildRangeHeader,
  isRangeNotSatisfiable,
  parseContentRange,
} from './installer-downloader'

describe('buildRangeHeader', () => {
  test('没有 .part（或为空）时不构造 Range 头', () => {
    expect(buildRangeHeader(0)).toBeUndefined()
    expect(buildRangeHeader(-1)).toBeUndefined()
    expect(buildRangeHeader(Number.NaN)).toBeUndefined()
    expect(buildRangeHeader(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  test('已有 .part 时从已有字节处续传', () => {
    expect(buildRangeHeader(1)).toBe('bytes=1-')
    expect(buildRangeHeader(1048576)).toBe('bytes=1048576-')
  })

  test('非整数 size 向下取整，避免非法头值', () => {
    expect(buildRangeHeader(12.9)).toBe('bytes=12-')
  })
})

describe('parseContentRange', () => {
  test('解析 206 的起点 / 终点 / 总长', () => {
    expect(parseContentRange('bytes 100-999/1000')).toEqual({
      start: 100,
      end: 999,
      total: 1000,
    })
    expect(parseContentRange('bytes 0-0/1')).toEqual({ start: 0, end: 0, total: 1 })
  })

  test('总长为 * 时 total 为 null（仅知起点）', () => {
    expect(parseContentRange('bytes 500-999/*')).toEqual({
      start: 500,
      end: 999,
      total: null,
    })
  })

  test('兼容大小写与首尾空白', () => {
    expect(parseContentRange('  BYTES 10-19/100  ')).toEqual({
      start: 10,
      end: 19,
      total: 100,
    })
  })

  test('缺失或格式非法返回 null', () => {
    expect(parseContentRange(undefined)).toBeNull()
    expect(parseContentRange(null)).toBeNull()
    expect(parseContentRange('')).toBeNull()
    // 416 场景下的 `bytes */1000` 不带区间，无法用于续传
    expect(parseContentRange('bytes */1000')).toBeNull()
    expect(parseContentRange('items 0-9/100')).toBeNull()
    expect(parseContentRange('bytes 100-99/200')).toBeNull()
    expect(parseContentRange('bytes abc-def/200')).toBeNull()
  })

  test('206 场景下 total 应由 起点 + Content-Length 推导（剩余字节语义）', () => {
    const range = parseContentRange('bytes 100-999/1000')
    const contentLength = 900
    expect(range).not.toBeNull()
    expect(range!.start + contentLength).toBe(1000)
    expect(range!.total).toBe(1000)
  })
})

describe('isRangeNotSatisfiable', () => {
  test('416 识别为 Range 不可满足', () => {
    expect(isRangeNotSatisfiable(416)).toBe(true)
  })

  test('其他状态码不算', () => {
    expect(isRangeNotSatisfiable(200)).toBe(false)
    expect(isRangeNotSatisfiable(206)).toBe(false)
    expect(isRangeNotSatisfiable(404)).toBe(false)
    expect(isRangeNotSatisfiable(undefined)).toBe(false)
    expect(isRangeNotSatisfiable(null)).toBe(false)
  })
})
