/**
 * 全局模态叠加态（Overlay Coordinator）单元测试
 *
 * 覆盖：叠加计数派生遮挡判定、以及计数回退到 0 时遮挡解除（保证原生视图不被永久隐藏）。
 */

import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { globalOverlayCountAtom, isGlobalOverlayActiveAtom } from './overlay-atoms'

describe('全局模态叠加态（Overlay Coordinator）', () => {
  test('计数为 0 时无遮挡；> 0 时判定遮挡中', () => {
    const store = createStore()
    expect(store.get(globalOverlayCountAtom)).toBe(0)
    expect(store.get(isGlobalOverlayActiveAtom)).toBe(false)

    store.set(globalOverlayCountAtom, (count) => count + 1)
    expect(store.get(isGlobalOverlayActiveAtom)).toBe(true)

    store.set(globalOverlayCountAtom, (count) => count + 1)
    expect(store.get(globalOverlayCountAtom)).toBe(2)
  })

  test('嵌套模态逐个关闭，计数归零后遮挡解除', () => {
    const store = createStore()
    store.set(globalOverlayCountAtom, (count) => count + 1)
    store.set(globalOverlayCountAtom, (count) => count + 1)
    expect(store.get(isGlobalOverlayActiveAtom)).toBe(true)

    store.set(globalOverlayCountAtom, (count) => Math.max(0, count - 1))
    expect(store.get(isGlobalOverlayActiveAtom)).toBe(true)

    store.set(globalOverlayCountAtom, (count) => Math.max(0, count - 1))
    expect(store.get(globalOverlayCountAtom)).toBe(0)
    expect(store.get(isGlobalOverlayActiveAtom)).toBe(false)

    // 异常路径下多重回退也绝不为负（否则派生判定会持续错乱）
    store.set(globalOverlayCountAtom, (count) => Math.max(0, count - 1))
    expect(store.get(globalOverlayCountAtom)).toBe(0)
  })
})
