/**
 * 当前是否处于深色渲染（含 system / special 皮肤）。
 *
 * 首帧防闪烁：冷启动时 atom 可能尚未完成设置水合，而 index.html 的首屏脚本
 * 已同步把 .dark 写到 <html>。因此 DOM 上的 .dark 视为「已生效事实」，
 * 与 atom 取或，避免校徽/模型 Logo 出现「亮色图 → 暗色图」的一帧跳变。
 */
import { useAtomValue } from 'jotai'

import { resolvedThemeAtom } from '@/atoms/theme'

export function useIsDarkTheme(): boolean {
  const theme = useAtomValue(resolvedThemeAtom)
  if (typeof document !== 'undefined') {
    return document.documentElement.classList.contains('dark') || theme === 'dark'
  }
  return theme === 'dark'
}
