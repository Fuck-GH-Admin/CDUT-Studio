/**
 * 智联万站 · CDP 异常信息提取（yanhu-devtools-hub）单元测试
 *
 * 覆盖：优先取 `exception.description`（真实异常，如 TypeError: Illegal invocation），
 * 而非 Chrome 对未捕获异常仅给出的笼统 `text: "Uncaught"`。
 */

import { describe, expect, test } from 'bun:test'
import { resolveCdpExceptionMessage } from './yanhu-devtools-hub'

describe('resolveCdpExceptionMessage（CDP 异常信息提取）', () => {
  test('优先取 exception.description 首行，而非笼统的 text="Uncaught"', () => {
    const message = resolveCdpExceptionMessage({
      text: 'Uncaught',
      exception: { description: 'TypeError: Illegal invocation\n    at <anonymous>:3:9' },
    })
    expect(message).toBe('TypeError: Illegal invocation')
  })

  test('无 description 时回退 text', () => {
    expect(resolveCdpExceptionMessage({ text: 'SyntaxError: Unexpected token' })).toBe('SyntaxError: Unexpected token')
  })

  test('无任何可用异常信息时返回 null（调用方据此判定不抛出）', () => {
    expect(resolveCdpExceptionMessage(undefined)).toBeNull()
    expect(resolveCdpExceptionMessage(null)).toBeNull()
    expect(resolveCdpExceptionMessage({})).toBeNull()
    expect(resolveCdpExceptionMessage({ text: '   ' })).toBeNull()
  })
})
