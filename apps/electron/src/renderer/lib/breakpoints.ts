/**
 * 断点单一事实源。
 *
 * 同一组数值同时用于两处，改动必须成对：
 * 1. Tailwind 响应式变体（`lg:` / `xl:` 等），见 `apps/electron/tailwind.config.js`
 *    的 `theme.extend.screens`（显式声明，注释指向本文件）；
 * 2. 必须用像素判断的 JS 逻辑（如 `window.innerWidth < BREAKPOINTS.lg`），
 *    因为媒体查询在运行时不可读，只能复用同一组常量。
 *
 * 数值与 Tailwind 默认断点一致：显式声明只是把「隐式默认」变成可追踪的单一来源，
 * 生成的 CSS 不变。
 */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const

export type BreakpointKey = keyof typeof BREAKPOINTS
