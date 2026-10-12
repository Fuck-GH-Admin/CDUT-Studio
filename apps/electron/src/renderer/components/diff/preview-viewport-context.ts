/**
 * 预览视口控制器契约
 *
 * 预览内容（PDF / Office / 图片 / OFV…）各自拥有**原生**的缩放与平移实现：
 * - PDF：`pdf-zoom` / `pdf-scroll` postMessage；
 * - Office（Silurus）：`viewer.setScale` / `fitWidth` / 内部滚动宿主；
 * - 图片：`useSmoothZoom`；
 * - 文本 / 代码 / Markdown：仅原生滚动（无缩放）。
 *
 * 早期 `InteractivePreviewViewport` 用整屏 CSS `transform` 同时实现平移与缩放，
 * 会把 viewer 自带的工具栏、Excel 行列号栏、底部缩放条一并缩放，并把滚动条推出视口。
 * 现在视口只负责「手势」：平移交给底层原生滚动，缩放交给内容注册的控制器，
 * 从而保证只有内容区被缩放、固定 UI 保持不动。
 */

import * as React from 'react'

export interface PreviewViewController {
  zoomIn(): void
  zoomOut(): void
  /** 适应宽度 / 适应页面（可选） */
  fit?(): void
  /** 复位到 100%（可选） */
  reset?(): void
  /** 返回当前缩放比（1 = 100%）；返回 null 表示暂不可用 */
  getScale?(): number | null
  /**
   * 设置绝对缩放比（1 = 100%）。用于视口状态记忆恢复上一次的缩放；
   * 未实现时视口跳过缩放恢复（仅恢复滚动位置）。
   */
  setScale?(scale: number): void
  /**
   * 平移手势：`dx/dy` 为本次指针位移（屏幕像素）。返回 `true` 表示已消费（如 PDF
   * iframe 内滚动、图片平移）；返回 `false`/未实现时，视口回退为滚动指针下最深可滚动元素。
   */
  panBy?(dx: number, dy: number): boolean
}

export interface PreviewViewportContextValue {
  /** 当前交互模式：`select` 文本选择 / `hand` 抓手平移 */
  tool: 'select' | 'hand'
  /** 内容注册自己的原生缩放/平移控制器；返回注销函数 */
  register(controller: PreviewViewController): () => void
  /** 内容缩放变化时上报（用于刷新百分比显示） */
  reportScale(scale: number): void
}

export const PreviewViewportContext = React.createContext<PreviewViewportContextValue | null>(null)

/** 供预览内容组件消费；不在预览视口内（如主区 tab）时返回 null。 */
export function usePreviewViewport(): PreviewViewportContextValue | null {
  return React.useContext(PreviewViewportContext)
}
