/**
 * banner-key-scope — 交互横幅的全局键盘作用域判定
 *
 * 三个交互横幅（AskUser / ExitPlanMode / Permission）都在 document 上监听 keydown。
 * 为了防止在侧边栏、设置或输入框内按 Enter 时被横幅误劫持，统一用排除式规则：
 * - 横幅内部：接管；
 * - 外部可编辑控件 / 外部可交互控件：放行（保留其原生键盘语义）；
 * - 其余场景（body、聊天漫游容器 tabIndex=-1、普通容器）：继续接管，
 *   保证用户点击聊天区后仍可用键盘操作横幅。
 */

import { isEditableTarget } from './navigation-controller'

/** 外部可交互控件：这些元素上的 Enter / 方向键属于其原生语义，横幅不得接管 */
const EXTERNAL_INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'select',
  'summary',
  '[contenteditable="true"]',
  '.ProseMirror',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="treeitem"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="link"]',
].join(', ')

export interface BannerKeyScope {
  /** 事件目标位于横幅容器内 */
  insideBanner: boolean
  /** 事件目标是可编辑控件 */
  editable: boolean
  /** 事件目标位于外部可交互控件内 */
  interactiveControl: boolean
}

/** 判定全局 keydown 是否应由横幅接管。 */
export function shouldHandleBannerKey(scope: BannerKeyScope): boolean {
  if (scope.insideBanner) return true
  if (scope.editable || scope.interactiveControl) return false
  return true
}

/** 从原生键盘事件解析作用域（仅浏览器环境调用）。 */
export function resolveBannerKeyScope(event: KeyboardEvent, container: HTMLElement | null): BannerKeyScope {
  const target = event.target
  const element = target instanceof Element ? target : null
  const insideBanner = container != null && element != null && container.contains(element)
  return {
    insideBanner,
    editable: isEditableTarget(target),
    interactiveControl: element != null && element.closest(EXTERNAL_INTERACTIVE_SELECTOR) != null,
  }
}
