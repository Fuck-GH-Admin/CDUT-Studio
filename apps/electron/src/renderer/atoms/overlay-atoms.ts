/**
 * 全局模态叠加态调度（Overlay Coordinator）
 *
 * Electron 的原生 `WebContentsView`（智联万站内嵌页）是 OS 级视图句柄（Windows HWND），
 * 恒定凌驾于 Chromium DOM 图层之上——无论 React 模态弹窗（设置面板 / 课堂选择器 /
 * 写操作二次确认 / 思维导图全屏模态）设置多高的 z-index，原生视口都会如同一块钢板
 * 硬性遮挡在这些模态界面之上。
 *
 * 因此需要一套全局叠加计数：任意全局阻断性模态打开即 +1、关闭即 -1；
 * 智联万站视图（`YanhuExpressView`）与桌宠订阅该派生只读原子，一旦 > 0 即上报
 * `visible=false`，让主进程瞬时（毫秒级、无重载、不丢页面状态）隐去原生图层，
 * 令 React 模态完整显现；模态关闭后再毫秒级原位恢复。
 */

import { atom, useSetAtom } from 'jotai'
import { useEffect } from 'react'

/** 全局模态叠加计数（打开 +1 / 关闭 -1，恒为非负） */
export const globalOverlayCountAtom = atom(0)

/** 是否存在激活的全局阻断性模态（派生只读）：> 0 即遮挡中，原生视图与桌宠必须瞬时隐去 */
export const isGlobalOverlayActiveAtom = atom((get) => get(globalOverlayCountAtom) > 0)

/**
 * 声明式注册全局模态开合：open=true 时计数 +1，关闭或组件卸载时 -1。
 *
 * 采用「挂载即登记、卸载即回退」的效应式实现，保证「模态打开途中被强制卸载」等异常路径
 * 也能精确回退计数，绝不出现计数泄漏导致原生视图永久隐藏。
 */
export function useGlobalOverlay(open: boolean): void {
  const setCount = useSetAtom(globalOverlayCountAtom)
  useEffect(() => {
    if (!open) return
    setCount((count) => count + 1)
    return () => setCount((count) => Math.max(0, count - 1))
  }, [open, setCount])
}
