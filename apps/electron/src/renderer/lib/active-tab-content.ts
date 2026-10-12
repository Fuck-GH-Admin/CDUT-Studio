import { SCRATCH_PAD_ID, TUTORIAL_TAB_ID, type TabItem } from '@/atoms/tab-atoms'

/**
 * 解析主内容实际应显示的 Tab。只接受仍存在的同步 activeTabId，
 * 防止标签高亮与内容所属会话在 deferred 值上暂时分叉。
 */
export function resolveContentTabId(tabs: readonly TabItem[], activeTabId: string | null): string | null {
  if (!activeTabId) return null
  return tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null
}

/**
 * 主区是否应显示「新建会话」启动页（WelcomeView）。
 *
 * 只有同时满足以下两点时才显示：
 * 1. 不存在任何真实内容标签（agent / chat / browser / 教程 之外的会话标签）；
 * 2. 当前激活的不是后台常驻 Tab（Scratch Pad / 教程）。
 *
 * 关键约束：教程 Tab 与 Scratch Pad 都是**有效内容**，必须交给 TabContent 渲染。
 * 历史缺陷：判定只排除了 Scratch Pad，导致教程 Tab 被当成空态——打开教程（或关闭
 * 最后一个会话后只剩教程）时主区会渲染成新建会话，教程正文被顶掉。
 */
export function shouldShowWelcomeLauncher(
  tabs: readonly TabItem[],
  activeTabId: string | null,
): boolean {
  const hasContentTab = tabs.some(
    (tab) => tab.id !== SCRATCH_PAD_ID && tab.type !== 'tutorial',
  )
  if (hasContentTab) return false
  return activeTabId !== SCRATCH_PAD_ID && activeTabId !== TUTORIAL_TAB_ID
}
