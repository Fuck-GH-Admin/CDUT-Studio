/**
 * 编辑距离与模糊文本定位单元测试（Bug 15）
 *
 * 覆盖：基础编辑距离、标点/空白/全半角差异容忍、原文坐标还原、
 * 完全不匹配返回 null、自定义阈值、空输入。
 */

import { describe, expect, test } from 'bun:test'
import { findFuzzyRange, levenshtein } from './levenshtein'

describe('levenshtein', () => {
  test('Given 相同字符串 Then 距离为 0', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('', '')).toBe(0)
  })

  test('Given 单字符差异 Then 距离为 1', () => {
    expect(levenshtein('abc', 'abd')).toBe(1)
    expect(levenshtein('abc', 'ab')).toBe(1)
    expect(levenshtein('abc', 'abcd')).toBe(1)
  })

  test('Given 多字符差异 Then 距离累加', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('flaw', 'lawn')).toBe(2)
  })

  test('Given 空串与非空串 Then 距离为长度', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })

  test('Given 非对称输入 Then 结果与参数顺序无关', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(levenshtein('sitting', 'kitten'))
  })
})

describe('findFuzzyRange', () => {
  test('Given 完全一致的片段 Then 精确定位', () => {
    const hay = '这是一个关于地球物理反演的研究结论。'
    const target = '地球物理反演'
    const hit = findFuzzyRange(hay, target)
    expect(hit).not.toBeNull()
    expect(hay.slice(hit!.start, hit!.end)).toBe(target)
    expect(hit!.score).toBe(1)
  })

  test('Given 标点差异 Then 仍能命中', () => {
    const hay = '研究结论：地球物理反演，具有多解性。'
    const target = '地球物理反演,具有多解性'  // 逗号用了半角
    const hit = findFuzzyRange(hay, target)
    expect(hit).not.toBeNull()
  })

  test('Given 空白符差异 Then 仍能命中', () => {
    const hay = '地球物理 反演 具有多解性'
    const target = '地球物理反演具有多解性'
    const hit = findFuzzyRange(hay, target)
    expect(hit).not.toBeNull()
  })

  test('Given 全角括号差异 Then 仍能命中', () => {
    const hay = '方法（Method）是核心'
    const target = '方法(Method)是核心'
    const hit = findFuzzyRange(hay, target)
    expect(hit).not.toBeNull()
    expect(hay.slice(hit!.start, hit!.end)).toBe('方法（Method）是核心')
  })

  test('Given 少量错别字 Then 仍能命中且分数下降', () => {
    const hay = '地球物理反演具有多解性'
    const target = '地球物理反演具有多简性'
    const hit = findFuzzyRange(hay, target)
    expect(hit).not.toBeNull()
    expect(hit!.score).toBeLessThan(1)
    expect(hit!.score).toBeGreaterThan(0.7)
  })

  test('Given 完全不相干 Then 返回 null，绝不猜测', () => {
    const hay = '这是一个完全无关的句子'
    const target = '量子色动力学的渐近自由'
    expect(findFuzzyRange(hay, target)).toBeNull()
  })

  test('Given 紧凑阈值 Then 略有差异即拒绝', () => {
    const hay = '地球物理反演具有多解性'
    const target = '地球物理反演具有多简性'
    expect(findFuzzyRange(hay, target, { maxRatio: 0 })).toBeNull()
    expect(findFuzzyRange(hay, target, { maxRatio: 0.25 })).not.toBeNull()
  })

  test('Given 空输入 Then 返回 null', () => {
    expect(findFuzzyRange('', 'abc')).toBeNull()
    expect(findFuzzyRange('abc', '')).toBeNull()
  })

  test('Given 折叠后命中 Then 返回原文坐标而非折叠坐标', () => {
    const hay = '前言　　研究结论：反演。'
    const target = '研究结论:反演'
    const hit = findFuzzyRange(hay, target)
    expect(hit).not.toBeNull()
    const slice = hay.slice(hit!.start, hit!.end)
    expect(slice.startsWith('研究结论')).toBe(true)
    expect(slice.endsWith('反演。') || slice.endsWith('反演')).toBe(true)
  })
})
