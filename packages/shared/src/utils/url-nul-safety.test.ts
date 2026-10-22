import { describe, expect, test } from 'bun:test'

import { UnsafeUrlCharacterError, assertSafeUrlNoNul } from './url-nul-safety'

describe('URL NUL 截断防御', () => {
  test('合法 URL 原样通过', () => {
    expect(assertSafeUrlNoNul('https://example.com/path?q=1')).toBe('https://example.com/path?q=1')
    expect(assertSafeUrlNoNul('http://127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/app')
    expect(assertSafeUrlNoNul('https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx')).toBe(
      'https://jw.cdut.edu.cn/jsxsd/framework/xsMainV.htmlx',
    )
  })

  test('裸 NUL 字符被拒绝', () => {
    expect(() => assertSafeUrlNoNul('https://evil\0.example.com/')).toThrow(UnsafeUrlCharacterError)
    expect(() => assertSafeUrlNoNul('https://example.com/\0')).toThrow(UnsafeUrlCharacterError)
  })

  test('百分号编码 NUL（大小写不敏感）被拒绝', () => {
    expect(() => assertSafeUrlNoNul('https://example.com/%00')).toThrow(UnsafeUrlCharacterError)
    expect(() => assertSafeUrlNoNul('https://example.com/%0A')).toThrow(UnsafeUrlCharacterError)
    expect(() => assertSafeUrlNoNul('https://a%00b.example.com/')).toThrow(UnsafeUrlCharacterError)
  })

  test('其余 C0 控制字符与 DEL 被拒绝', () => {
    expect(() => assertSafeUrlNoNul('https://example.com/\u0007')).toThrow(UnsafeUrlCharacterError)
    expect(() => assertSafeUrlNoNul('https://exa\u001fple.com/')).toThrow(UnsafeUrlCharacterError)
    expect(() => assertSafeUrlNoNul('https://example.com/\u007f')).toThrow(UnsafeUrlCharacterError)
  })

  test('空输入被拒绝', () => {
    expect(() => assertSafeUrlNoNul('')).toThrow(UnsafeUrlCharacterError)
  })

  test('无法解析的字符串不做额外拦截（交由调用方解析逻辑）', () => {
    expect(assertSafeUrlNoNul('not a url')).toBe('not a url')
  })
})
