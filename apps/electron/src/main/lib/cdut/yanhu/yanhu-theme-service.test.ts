/**
 * 智联万站主题跟随单元测试（对应规格书 7.1.4）
 *
 * 覆盖：浅色 / 深色 / 跟随系统三态下，底层视图底色解析准确无误
 * （深色 #09090b，浅色 #ffffff）。
 */

import { describe, expect, test } from 'bun:test'
import { resolveYanhuIsDark, resolveYanhuThemeBackground } from './yanhu-theme-service'
import {
  YANHU_DARK_VIEW_BACKGROUND,
  YANHU_LIGHT_VIEW_BACKGROUND,
  resolveYanhuViewBackground,
} from './yanhu-constants'

describe('resolveYanhuIsDark', () => {
  test('light 恒为浅色，dark 恒为深色', () => {
    expect(resolveYanhuIsDark('light', true)).toBe(false)
    expect(resolveYanhuIsDark('light', false)).toBe(false)
    expect(resolveYanhuIsDark('dark', true)).toBe(true)
    expect(resolveYanhuIsDark('dark', false)).toBe(true)
  })

  test('system 跟随操作系统明暗', () => {
    expect(resolveYanhuIsDark('system', true)).toBe(true)
    expect(resolveYanhuIsDark('system', false)).toBe(false)
  })
})

describe('resolveYanhuThemeBackground 底色防白闪', () => {
  test('深色模式解析为 #09090b', () => {
    expect(resolveYanhuThemeBackground('dark', false)).toBe('#09090b')
    expect(resolveYanhuThemeBackground('system', true)).toBe('#09090b')
  })

  test('浅色模式解析为 #ffffff', () => {
    expect(resolveYanhuThemeBackground('light', true)).toBe('#ffffff')
    expect(resolveYanhuThemeBackground('system', false)).toBe('#ffffff')
  })

  test('常量与解析函数口径一致', () => {
    expect(YANHU_DARK_VIEW_BACKGROUND).toBe('#09090b')
    expect(YANHU_LIGHT_VIEW_BACKGROUND).toBe('#ffffff')
    expect(resolveYanhuViewBackground(true)).toBe('#09090b')
    expect(resolveYanhuViewBackground(false)).toBe('#ffffff')
  })
})
